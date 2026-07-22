// @ts-check
"use strict";

const fsSync = require("fs");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const engineCore = require("./engine-core");
const { reconcileRunningRecord } = require("./run-lifecycle");

// Shared configuration, state, validation, cancellation, and accounting primitives.
/** @returns {import("./engine-types").Foundation} */
module.exports = function createFoundation() {
const MAX_WORKERS = 8;
const DEFAULT_WORKERS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_MAX_AGENTS = 1000;
const MAX_NESTING_DEPTH = 1;
const DEFAULT_LAUNCH_STAGGER_MS = 25;
const VALID_SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const DEFAULT_MODEL = "gpt-5.6-terra";
const DEFAULT_REASONING_EFFORT = "medium";
const GPT_5_6_MODELS = Object.freeze(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const GPT_5_6_REASONING_EFFORTS = Object.freeze(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
const VALID_EFFORTS = new Set(GPT_5_6_REASONING_EFFORTS);
// Worker transports. 'exec' (default) = today's `codex exec --json` JSONL
// scraping, byte-for-byte unchanged. 'app-server' = opt-in versioned JSON-RPC
// app-server transport (with automatic fallback to exec). 'exec-server' = a
// reserved value that throws an explicit not-implemented error (the seam is kept
// open but the heavier ws/remote-executor integration is deferred).
const VALID_TRANSPORTS = new Set(["exec", "app-server", "exec-server"]);

const WORKER_ROLES = [
  {
    id: "context-scout",
    title: "Context Scout",
    focus:
      "Map the relevant files, entry points, existing patterns, and constraints. Avoid implementation unless asked."
  },
  {
    id: "implementation-planner",
    title: "Implementation Planner",
    focus:
      "Propose the smallest coherent implementation path that fits the existing codebase and avoids unnecessary infrastructure."
  },
  {
    id: "risk-reviewer",
    title: "Risk Reviewer",
    focus:
      "Look for regressions, hidden coupling, missing tests, unsafe assumptions, and behavioral edge cases."
  },
  {
    id: "test-strategist",
    title: "Test Strategist",
    focus:
      "Identify the most meaningful verification commands, fixtures, and focused tests for the task."
  },
  {
    id: "api-contract-reviewer",
    title: "API Contract Reviewer",
    focus:
      "Check schemas, public contracts, tool interfaces, and compatibility boundaries."
  },
  {
    id: "cleanup-reviewer",
    title: "Cleanup Reviewer",
    focus:
      "Find stale paths, redundant abstractions, deprecated code, and opportunities to keep the change lean."
  },
  {
    id: "docs-operator",
    title: "Docs Operator",
    focus:
      "Identify only durable documentation or instruction updates that are genuinely required."
  },
  {
    id: "final-verifier",
    title: "Final Verifier",
    focus:
      "Review the proposed path as if signing off on the work. Be concrete about remaining proof needed."
  }
];

const WORKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    recommended_actions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    verification: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  },
  required: ["summary", "findings", "recommended_actions", "risks", "verification", "confidence"]
};

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    refuted: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["refuted", "reason"]
};

function codexHome() {
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return process.env.CODEX_HOME.trim();
  }
  return path.join(os.homedir(), ".codex");
}

function isExecutable(filePath) {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return fsSync.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function defaultCodexBin() {
  if (process.env.CODEX_CLI_PATH && process.env.CODEX_CLI_PATH.trim()) {
    return process.env.CODEX_CLI_PATH.trim();
  }

  const candidates = [
    path.join(path.dirname(process.execPath), "codex"),
    "/Applications/Codex zemaj.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"
  ];
  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  return "codex";
}

function stateDir() {
  return path.join(codexHome(), "ultracode", "runs");
}

function statePathFor(id) {
  return path.join(stateDir(), `${id}.json`);
}

function assertNonEmptyString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function positiveInteger(value, fallback, max) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`workers must be an integer between 1 and ${max}.`);
  }
  return Math.min(number, max);
}

function resolveModel(value) {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_MODEL;
}

function resolveReasoningEffort(value) {
  return value || DEFAULT_REASONING_EFFORT;
}

function normalizeOptions(input = {}) {
  const task = assertNonEmptyString(input.task, "task");
  const cwd = path.resolve(input.cwd || process.cwd());
  const workerCount = positiveInteger(input.workers, DEFAULT_WORKERS, MAX_WORKERS);
  const sandbox = input.sandbox || "read-only";
  if (!VALID_SANDBOXES.has(sandbox)) {
    throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const reasoningEffort = resolveReasoningEffort(input.reasoning_effort || input.reasoningEffort);
  if (reasoningEffort !== undefined && !VALID_EFFORTS.has(reasoningEffort)) {
    throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const timeoutMs =
    input.timeout_ms === undefined || input.timeout_ms === null
      ? DEFAULT_TIMEOUT_MS
      : Math.max(1_000, Math.floor(Number(input.timeout_ms)));
  if (!Number.isFinite(timeoutMs)) {
    throw new Error("timeout_ms must be a finite number.");
  }

  return {
    task,
    cwd,
    workers: workerCount,
    sandbox,
    model: resolveModel(input.model),
    reasoning_effort: reasoningEffort,
    timeout_ms: timeoutMs,
    // Opt-in transport (default 'exec' = unchanged). resolveTransport coerces an
    // unknown value back to 'exec', so a stray input never changes the default.
    transport: resolveTransport(firstDefined(input.transport, process.env.ULTRACODE_TRANSPORT)),
    transport_strict: resolveBool(firstDefined(input.transport_strict, input.transportStrict), false),
    codex_bin:
      typeof input.codex_bin === "string" && input.codex_bin.trim()
        ? input.codex_bin.trim()
        : defaultCodexBin(),
    codex_home:
      typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome()
  };
}

function selectRoles(count) {
  return WORKER_ROLES.slice(0, count).map((role, index) => ({
    index,
    id: role.id,
    title: role.title,
    focus: role.focus
  }));
}

function planWorkflow(input = {}) {
  const options = normalizeOptions(input);
  return {
    task: options.task,
    cwd: options.cwd,
    workers: selectRoles(options.workers),
    defaults: {
      sandbox: options.sandbox,
      timeout_ms: options.timeout_ms,
      model: options.model || null,
      reasoning_effort: options.reasoning_effort || null
    }
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function latestStatePath() {
  let entries;
  try {
    entries = await fs.readdir(stateDir(), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(stateDir(), entry.name));
  if (files.length === 0) return null;
  const stats = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0].file;
}

async function readWorkflow(input = {}) {
  let filePath;
  if (input.state_path) {
    filePath = path.resolve(assertNonEmptyString(input.state_path, "state_path"));
  } else if (input.workflow_id) {
    filePath = statePathFor(assertNonEmptyString(input.workflow_id, "workflow_id"));
  } else {
    filePath = await latestStatePath();
  }
  if (!filePath) {
    return { status: "missing", message: "No Ultracode workflow state exists yet." };
  }
  const record = await readJson(filePath);
  const reconciled = reconcileRunningRecord(record);
  if (reconciled.changed) {
    await writeJson(filePath, reconciled.record);
  }
  return reconciled.record;
}

// ---------------------------------------------------------------------------
// Orchestration primitives
//
// These stable, dependency-free primitives are implemented in src/engine-core.ts
// and compiled to ./engine-core for the CommonJS plugin runtime.
// ---------------------------------------------------------------------------

const {
  DEFAULT_GLOBAL_CONCURRENCY,
  defaultConcurrency,
  normalizeConcurrency,
  normalizeGlobalConcurrency,
  createLimiter,
  emitEvent,
  log,
  USAGE_KEYS,
  emptyUsage,
  addUsageInto,
  accountUsage,
  sumUsageFromWorkers,
  validateAgainstSchema,
  stableStringify,
  stepId
} = engineCore;

function createContext(opts = {}) {
  return engineCore.createContext(opts, {
    defaultMaxAgents: DEFAULT_MAX_AGENTS,
    maxNestingDepth: MAX_NESTING_DEPTH,
    defaultLaunchStaggerMs: DEFAULT_LAUNCH_STAGGER_MS
  });
}

// ---------------------------------------------------------------------------
// Transient-error classification + bounded exponential backoff
//
// A non-zero `codex exec` exit (or a spawn errno) is classified into transient
// (worth retrying with backoff) vs permanent (fail immediately, exactly as the
// engine did before this layer existed). The default is fail-closed: an unknown
// non-zero exit is treated as PERMANENT so behavior matches the pre-retry engine
// unless a pattern explicitly marks it transient. Retries are SEPARATE from the
// schema-validation retry loop (a schema-invalid-but-exit-0 run is never
// transient — it parsed fine and exited 0).
// ---------------------------------------------------------------------------

// errno codes that mean the binary itself is wrong / unrunnable — never retry.
const PERMANENT_SPAWN_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOTDIR"]);
// errno that can transiently happen when the freshly-written/locked bin is busy.
const TRANSIENT_SPAWN_CODES = new Set(["ETXTBSY"]);

// Auth refresh races can appear as "Authentication expired" plus a refresh-token
// diagnostic. Keep permanent credential failures separate from refresh transport
// failures so bad login state stays loud, while a refresh server/race hiccup can
// be restarted once even when broad transient retries are off.
const PERMANENT_AUTH_REFRESH_RE = /authentication required|run [`']?(?:code|codex) login|invalid api key|invalid_grant|invalid_client|refresh token (?:expired|already (?:used|rotated)|revoked|invalidated|unavailable; please sign in)|please (?:log out and )?sign in again/i;
const TRANSIENT_AUTH_REFRESH_RE = /(?:authentication expired\.\s*)?\b(?:oauth|auth|access token|token|refresh token)\b.{0,120}(?:temporar(?:ily)? unavailable|server busy|timed? out|timeout|network|connection reset|connection refused|econnreset|econnrefused|etimedout|5\d\d|429|try again|unexpected response)/i;
// Permanent stderr/stdout signatures (auth / bad-flag / usage / schema). Checked
// before generic retryable output so e.g. an "unauthorized" message is never
// mistaken for transient.
const PERMANENT_OUTPUT_RE = /unauthorized|invalid api key|authentication|forbidden\b|permission denied|unknown (option|argument|flag)|unrecognized|invalid value|schema|usage:/i;
// Retryable signatures: HTTP 429/5xx, rate-limit, known network errno, overload.
const RETRYABLE_OUTPUT_RE = /\b(429|5\d\d)\b|rate.?limit|too many requests|temporarily unavailable|timed? out|timeout|connection reset|connection refused|econnreset|econnrefused|etimedout|enetunreach|eai_again|socket hang up|network|server error|service unavailable|overloaded|please try again/i;

// Pure classifier. Inputs: the thrown Error (errno on error.code for spawn
// failures) and the attached exec result (error.codex_exec). Returns
// { transient, reason }.
function classifyCodexError(error, execResult) {
  const code = error && typeof error.code === "string" ? error.code : null;
  // Spawn-level errno is the most reliable signal — check it first.
  if (code && PERMANENT_SPAWN_CODES.has(code)) {
    return { transient: false, reason: `spawn ${code}` };
  }
  if (code && TRANSIENT_SPAWN_CODES.has(code)) {
    return { transient: true, reason: `spawn ${code}` };
  }
  const exec = execResult || (error && error.codex_exec) || null;
  // A child that never emitted a byte of its JSONL stream never reached useful
  // work. It is terminated by the short startup guard, then gets one implicit
  // fresh-process retry; completed work that times out remains non-retryable.
  if (exec && exec.startup_timed_out === true) {
    return { transient: true, reason: "startup timed out with no output", defaultMaxRetries: 1 };
  }
  // A timeout is treated as permanent: a retry would just re-burn the full
  // wall-clock timeout, multiplying cost for no benefit.
  if (exec && exec.timed_out === true) {
    return { transient: false, reason: "timed out" };
  }
  const haystack = exec ? `${exec.stderr || ""}\n${exec.stdout || ""}` : "";
  const runtimeFailed =
    exec &&
    ((typeof exec.exit_code === "number" && exec.exit_code !== 0) ||
      (exec.signal && exec.cancelled !== true && exec.timed_out !== true));
  // Permanent auth refresh patterns win over retryable ones.
  if (haystack && PERMANENT_AUTH_REFRESH_RE.test(haystack)) {
    return { transient: false, reason: "permanent error pattern" };
  }
  if (runtimeFailed && haystack && TRANSIENT_AUTH_REFRESH_RE.test(haystack)) {
    return { transient: true, reason: "retryable: auth refresh", defaultMaxRetries: 1 };
  }
  // Permanent patterns win over generic retryable ones.
  if (haystack && PERMANENT_OUTPUT_RE.test(haystack)) {
    return { transient: false, reason: "permanent error pattern" };
  }
  // Only a genuinely non-zero exit (not a schema/read failure on a clean exit)
  // qualifies as a retryable runtime error.
  if (runtimeFailed && haystack && RETRYABLE_OUTPUT_RE.test(haystack)) {
    const m = RETRYABLE_OUTPUT_RE.exec(haystack);
    return { transient: true, reason: m ? `retryable: ${m[0]}` : "retryable error pattern" };
  }
  // Fail closed: unknown non-zero exits behave exactly as before (no retry).
  return { transient: false, reason: "non-transient" };
}

// Bounded exponential backoff. attempt is the zero-based transient-retry index.
// exp = min(max, base * 2**attempt); full-jitter randomizes within [0, exp].
function backoffDelay(attempt, base, max, jitter) {
  const safeBase = Math.max(0, Number(base) || 0);
  const safeMax = Math.max(0, Number(max) || 0);
  const exp = Math.min(safeMax, safeBase * Math.pow(2, attempt));
  if (!jitter) return Math.floor(exp);
  return Math.floor(Math.random() * (exp + 1));
}

// Promise wrapping setTimeout(ms) that short-circuits if the AbortSignal is
// (or becomes) aborted. Rejects with an abort Error so callers can stop a retry
// loop mid-backoff. Pure Node timers; clears the timer + removes the listener on
// every settle path so nothing leaks.
/** @returns {Promise<void>} */
function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      cleanup();
      reject(abortError(signal));
    };
    function cleanup() {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** @returns {import("./engine-types").EngineError} */
function abortError(signal) {
  const reason = signal && signal.reason !== undefined ? signal.reason : "aborted";
  const err = /** @type {import("./engine-types").EngineError} */ (
    new Error(`cancelled: ${typeof reason === "string" ? reason : "aborted"}`)
  );
  err.code = "ABORT_ERR";
  err.cancelled = true;
  return err;
}

function reserveLaunchStagger(ctx) {
  if (!ctx || !ctx.launchStaggerMs || ctx.concurrency <= 1) return 0;
  const now = Date.now();
  const active = ctx.limiter && typeof ctx.limiter.active === "function" ? ctx.limiter.active() : 0;
  if (active <= 1) {
    ctx.nextLaunchAt = now + ctx.launchStaggerMs;
    return 0;
  }
  const startAt = Math.max(now, ctx.nextLaunchAt || now);
  ctx.nextLaunchAt = startAt + ctx.launchStaggerMs;
  return Math.max(0, startAt - now);
}

async function waitForLaunchStagger(ctx, label, phase) {
  const delayMs = reserveLaunchStagger(ctx);
  if (delayMs <= 0) return;
  emitEvent(ctx, { type: "worker.launch_stagger", label, phase, delay_ms: delayMs });
  await abortableDelay(delayMs, ctx ? ctx.signal : undefined);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function clampNonNegInt(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function resolveBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(false|0|no|off)$/i.test(value.trim())) return false;
    if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
  }
  return Boolean(value);
}

// Resolve a worker transport. Defaults to 'exec' (today's path). Only the exact
// strings 'app-server' and 'exec-server' select an alternative; everything else
// (undefined, empty, unknown) stays 'exec' so a stray env/option can never
// silently change the default behavior.
function resolveTransport(value) {
  if (typeof value !== "string") return "exec";
  const v = value.trim();
  return VALID_TRANSPORTS.has(v) ? v : "exec";
}

  return {
    MAX_WORKERS,
    DEFAULT_WORKERS,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_AGENTS,
    MAX_NESTING_DEPTH,
    DEFAULT_LAUNCH_STAGGER_MS,
    DEFAULT_GLOBAL_CONCURRENCY,
    VALID_SANDBOXES,
    DEFAULT_MODEL,
    DEFAULT_REASONING_EFFORT,
    GPT_5_6_MODELS,
    GPT_5_6_REASONING_EFFORTS,
    VALID_EFFORTS,
    VALID_TRANSPORTS,
    WORKER_ROLES,
    WORKER_SCHEMA,
    VERDICT_SCHEMA,
    codexHome,
    isExecutable,
    defaultCodexBin,
    stateDir,
    statePathFor,
    assertNonEmptyString,
    positiveInteger,
    resolveModel,
    resolveReasoningEffort,
    normalizeOptions,
    selectRoles,
    planWorkflow,
    writeJson,
    readJson,
    latestStatePath,
    readWorkflow,
    defaultConcurrency,
    normalizeConcurrency,
    normalizeGlobalConcurrency,
    createLimiter,
    emitEvent,
    log,
    USAGE_KEYS,
    emptyUsage,
    addUsageInto,
    accountUsage,
    sumUsageFromWorkers,
    createContext,
    validateAgainstSchema,
    stableStringify,
    stepId,
    classifyCodexError,
    backoffDelay,
    abortableDelay,
    abortError,
    reserveLaunchStagger,
    waitForLaunchStagger,
    firstDefined,
    clampNonNegInt,
    resolveBool,
    resolveTransport
  };
};
