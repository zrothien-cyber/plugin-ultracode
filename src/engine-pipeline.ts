"use strict";

const path = require("path");

const { workflowIdentity } = require("./run-identity");
const { controllerSnapshot } = require("./run-lifecycle");
const { attachWorkflowUi, shouldLaunchUi } = require("./ultracode-ui-launcher");

const DEFAULT_PIPELINE_BUDGET_FLOOR_TOKENS = 16_000_000;

// Declarative DAG compilation and execution built on the shared worker/journal primitives.
/**
 * @param {import("./engine-types").Foundation} foundation
 * @param {import("./engine-types").Execution} execution
 * @param {import("./engine-types").Workflows} workflows
 * @returns {import("./engine-types").Pipeline}
 */
module.exports = function createPipeline(foundation, execution, workflows) {
  const {
    DEFAULT_TIMEOUT_MS,
    VALID_SANDBOXES,
    VALID_EFFORTS,
    WORKER_SCHEMA,
    assertNonEmptyString,
    resolveModel,
    resolveReasoningEffort,
    defaultCodexBin,
    codexHome,
    statePathFor,
    writeJson,
    createContext,
    sumUsageFromWorkers,
    emitEvent,
    log,
    firstDefined,
    resolveBool,
    resolveTransport
  } = foundation;
  const { spawnWorker, runParallel, loopUntilDry, adversarialVerify } = execution;
  const { resolveRetryInput, transportJournal, makePersister, attachLiveJournalPersistence, finalizeRecord } = workflows;

function resolvePipelineBudget(input) {
  const raw = input.budget_tokens;
  if (raw === undefined || raw === null || raw === "") {
    return { effective: raw, requested: null, floor: null, strict: false };
  }

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) {
    return { effective: raw, requested: null, floor: null, strict: false };
  }

  const requested = Math.max(0, Math.floor(numeric));
  const strict = resolveBool(firstDefined(input.strict_budget, input.strictBudget), false);
  if (strict || requested === 0) {
    return { effective: requested, requested, floor: null, strict };
  }

  const configuredFloor = Number(process.env.ULTRACODE_PIPELINE_BUDGET_FLOOR_TOKENS);
  const floor =
    Number.isFinite(configuredFloor) && configuredFloor >= 0
      ? Math.floor(configuredFloor)
      : DEFAULT_PIPELINE_BUDGET_FLOOR_TOKENS;
  const effective = Math.max(requested, floor);

  return {
    effective,
    requested,
    floor: effective > requested ? floor : null,
    strict: false
  };
}

const VALID_STEP_KINDS = new Set(["worker", "parallel", "verify", "loop"]);

// Dot-path drill-in: getPath({a:{b:[1,2]}}, "a.b") => [1,2]. Bare ""/null
// returns the object itself. Missing path => undefined (caller decides).
function getPath(obj, dotPath) {
  if (dotPath === undefined || dotPath === null || dotPath === "") return obj;
  let cur = obj;
  for (const part of String(dotPath).split(".")) {
    if (part === "") continue;
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Serialize a rendered value: objects/arrays => pretty JSON, strings verbatim,
// other scalars => String(). Used for {{steps.<id>.output[...]}} substitution.
function renderValue(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

// Resolve {{ ... }} tokens against a scope built from already-settled deps plus
// per-kind extras (round / item). Recognized tokens:
//   {{steps.<id>.output}}          full dep output (pretty JSON if object)
//   {{steps.<id>.output.<path>}}   dot-path drill-in
//   {{steps.<id>.summary}}         dep output.summary
//   {{round}}                      loop round index
//   {{seen}} / {{seen_json}}       loop dedupe memory
//   {{consecutive_dry}}            loop dry streak
//   {{item.<key>}}                 parallel item field
// Any unresolved/leftover {{ }} throws (no silent blanks).
function renderTemplate(str, scope) {
  if (typeof str !== "string") return str;
  const steps = (scope && scope.steps) || {};
  const out = str.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (match, rawExpr) => {
    const expr = rawExpr.trim();
    if (expr === "round") {
      if (scope && scope.round !== undefined) return String(scope.round);
      throw new Error(`renderTemplate: {{round}} used outside a loop step.`);
    }
    if (expr === "seen" || expr === "seen_json") {
      if (!scope || !Array.isArray(scope.seen)) throw new Error(`renderTemplate: {{${expr}}} used outside a stateful loop step.`);
      return expr === "seen_json" ? JSON.stringify(scope.seen) : (scope.seen.length ? scope.seen.join("\n") : "(none)");
    }
    if (expr === "consecutive_dry") {
      if (scope && scope.consecutive_dry !== undefined) return String(scope.consecutive_dry);
      throw new Error(`renderTemplate: {{consecutive_dry}} used outside a loop step.`);
    }
    if (expr === "item" || expr.startsWith("item.")) {
      if (!scope || scope.item === undefined) {
        throw new Error(`renderTemplate: {{${expr}}} used outside a parallel item.`);
      }
      const value = expr === "item" ? scope.item : getPath(scope.item, expr.slice("item.".length));
      const rendered = renderValue(value);
      if (rendered === undefined) throw new Error(`renderTemplate: unresolved token {{${expr}}}.`);
      return rendered;
    }
    const stepMatch = /^steps\.([A-Za-z0-9_-]+)\.(output|summary)(?:\.(.+))?$/.exec(expr);
    if (stepMatch) {
      const [, id, kind, dotPath] = stepMatch;
      if (!(id in steps)) {
        throw new Error(`renderTemplate: unresolved token {{${expr}}} (step "${id}" is not a dependency).`);
      }
      const output = steps[id];
      let value;
      if (kind === "summary") {
        value = output && typeof output === "object" ? output.summary : undefined;
      } else {
        value = dotPath ? getPath(output, dotPath) : output;
      }
      const rendered = renderValue(value);
      if (rendered === undefined) throw new Error(`renderTemplate: unresolved token {{${expr}}}.`);
      return rendered;
    }
    throw new Error(`renderTemplate: unrecognized token {{${expr}}}.`);
  });
  // Defensive: reject any leftover braces the regex could not handle.
  if (/\{\{|\}\}/.test(out)) {
    throw new Error(`renderTemplate: unresolved template braces remain in: ${str}`);
  }
  return out;
}

// Collect every {{steps.<id>...}} id referenced by a string template. Used to
// enforce that a step only references ids in its own depends_on.
function referencedStepIds(str) {
  const ids = new Set();
  if (typeof str !== "string") return ids;
  const re = /\{\{\s*steps\.([A-Za-z0-9_-]+)\./g;
  let m;
  while ((m = re.exec(str)) !== null) ids.add(m[1]);
  return ids;
}

// Validate + normalize the JSON steps[] into compiled step descriptors. Throws
// (pre-spawn) on any structural error so a bad spec produces zero side effects.
function compileSteps(steps, defaults) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("steps must be a non-empty array.");
  }
  const byId = new Map();
  const compiled = steps.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new Error(`steps[${index}] must be an object.`);
    }
    const id = assertNonEmptyString(raw.id, `steps[${index}].id`);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`steps[${index}].id "${id}" must match [A-Za-z0-9_-]+.`);
    }
    if (byId.has(id)) {
      throw new Error(`steps[${index}].id "${id}" is duplicated.`);
    }
    const kind = raw.kind === undefined || raw.kind === null ? "worker" : raw.kind;
    if (!VALID_STEP_KINDS.has(kind)) {
      throw new Error(`steps[${index}].kind must be one of: ${Array.from(VALID_STEP_KINDS).join(", ")}.`);
    }
    const prompt = assertNonEmptyString(raw.prompt, `steps[${index}].prompt`);
    const dependsOn = Array.isArray(raw.depends_on) ? raw.depends_on.slice() : [];
    for (const dep of dependsOn) {
      if (typeof dep !== "string" || !dep.trim()) {
        throw new Error(`steps[${index}].depends_on entries must be non-empty strings.`);
      }
      if (dep === id) {
        throw new Error(`steps[${index}] "${id}" cannot depend on itself.`);
      }
    }
    const sandbox = raw.sandbox || defaults.sandbox;
    if (!VALID_SANDBOXES.has(sandbox)) {
      throw new Error(`steps[${index}].sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
    }
    const effort = raw.reasoning_effort || defaults.reasoning_effort;
    if (effort !== undefined && effort !== null && !VALID_EFFORTS.has(effort)) {
      throw new Error(`steps[${index}].reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
    }
    const schema =
      raw.schema === null ? null : raw.schema && typeof raw.schema === "object" ? raw.schema : WORKER_SCHEMA;
    // Optional warm executor per step. Defaults to the step-set default (cold).
    // 'fork' is accepted (forward-compat stub, degrades to cold). Validated here
    // so a bad value fails pre-spawn with zero side effects.
    const executor = raw.executor === undefined || raw.executor === null ? defaults.executor || "cold" : raw.executor;
    if (!["cold", "resume", "fork"].includes(executor)) {
      throw new Error(`steps[${index}].executor must be one of: cold, resume, fork.`);
    }
    const step: RuntimeRecord = {
      index,
      id,
      kind,
      prompt,
      depends_on: dependsOn,
      schema,
      label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id,
      phase: raw.phase || null,
      sandbox,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : defaults.model,
      reasoning_effort: effort || undefined,
      timeout_ms: raw.timeout_ms ? Math.max(1_000, Math.floor(Number(raw.timeout_ms))) : defaults.timeout_ms,
      cwd: raw.cwd ? path.resolve(raw.cwd) : defaults.cwd,
      isolation: raw.isolation === "worktree" ? "worktree" : undefined,
      executor
    };
    if (kind === "verify") {
      step.findings_from = assertNonEmptyString(raw.findings_from, `steps[${index}].findings_from`);
      step.findings_path =
        typeof raw.findings_path === "string" && raw.findings_path.trim() ? raw.findings_path.trim() : "findings";
      step.skeptics = raw.skeptics ? Math.max(1, Math.floor(Number(raw.skeptics))) : 3;
      step.lenses = Array.isArray(raw.lenses) ? raw.lenses.filter((l) => typeof l === "string" && l.trim()) : [];
      step.context = typeof raw.context === "string" ? raw.context : "";
    } else if (kind === "loop") {
      step.dry_rounds = raw.dry_rounds ? Math.max(1, Math.floor(Number(raw.dry_rounds))) : 2;
      step.max_rounds = raw.max_rounds ? Math.max(1, Math.floor(Number(raw.max_rounds))) : 10;
      step.dedupe_findings = Boolean(raw.dedupe || raw.dedupe_findings || raw.dedupeFindings);
    } else if (kind === "parallel") {
      if (Array.isArray(raw.items)) {
        for (const it of raw.items) {
          if (!it || typeof it !== "object" || Array.isArray(it)) {
            throw new Error(`steps[${index}].items entries must be objects.`);
          }
        }
        step.items = raw.items;
      } else if (raw.fanout !== undefined && raw.fanout !== null) {
        step.fanout = Math.max(1, Math.floor(Number(raw.fanout)));
      } else {
        step.fanout = 1;
      }
    }
    byId.set(id, step);
    return step;
  });

  // Edge validation: every depends_on / findings_from id must exist, and every
  // {{steps.<id>...}} token a step renders must be in that step's depends_on.
  for (const step of compiled) {
    for (const dep of step.depends_on) {
      if (!byId.has(dep)) {
        throw new Error(`steps "${step.id}" depends_on unknown step "${dep}".`);
      }
    }
    if (step.kind === "verify" && !step.depends_on.includes(step.findings_from)) {
      throw new Error(
        `steps "${step.id}" findings_from "${step.findings_from}" must be listed in its depends_on.`
      );
    }
    const depSet = new Set(step.depends_on);
    const refs = new Set([
      ...referencedStepIds(step.prompt),
      ...(step.kind === "verify" ? referencedStepIds(step.context) : [])
    ]);
    for (const ref of refs) {
      if (!byId.has(ref)) {
        throw new Error(`steps "${step.id}" template references unknown step "${ref}".`);
      }
      if (!depSet.has(ref)) {
        throw new Error(
          `steps "${step.id}" template references "${ref}" which is not in its depends_on.`
        );
      }
    }
  }

  // Kahn topological pre-pass: any remaining node after removing all
  // resolvable edges sits on a cycle.
  const indegree = new Map();
  for (const step of compiled) indegree.set(step.id, step.depends_on.length);
  const dependents = new Map();
  for (const step of compiled) dependents.set(step.id, []);
  for (const step of compiled) {
    for (const dep of step.depends_on) dependents.get(dep).push(step.id);
  }
  const queue = compiled.filter((s) => indegree.get(s.id) === 0).map((s) => s.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== compiled.length) {
    const cyclic = compiled.filter((s) => indegree.get(s.id) > 0).map((s) => s.id);
    throw new Error(`steps form a cycle involving: ${cyclic.join(", ")}.`);
  }

  return { compiled, byId };
}

// Build the resolved-deps scope ({steps:{<id>:output}}) for a step from the
// already-settled results map. output is the worker's parsed value (or array of
// values for a parallel/verify/loop step).
function depScope(step, results) {
  const stepsScope = {};
  for (const dep of step.depends_on) {
    stepsScope[dep] = results.has(dep) ? results.get(dep).output : undefined;
  }
  return { steps: stepsScope };
}

// Execute a single compiled step given its resolved dep outputs. Returns
// { output, workerResults } where workerResults is the flat list of spawnWorker
// records this step produced (for journaling), and output is the value injected
// into dependents.
async function executeStep(step, results, ctx, codexBin, codexHomeValue, retryWorker, transportOpts) {
  const baseScope = depScope(step, results);
  const common = {
    ctx,
    sandbox: step.sandbox,
    model: step.model,
    reasoningEffort: step.reasoning_effort,
    timeoutMs: step.timeout_ms,
    cwd: step.cwd,
    codex_bin: codexBin,
    codex_home: codexHomeValue,
    phase: step.phase,
    // Opt-in transport cascades from the pipeline level to every step's worker.
    ...(transportOpts && transportOpts.transport && transportOpts.transport !== "exec"
      ? { transport: transportOpts.transport, transport_strict: transportOpts.transportStrict }
      : {}),
    ...(retryWorker || {})
  };

  if (step.kind === "worker") {
    const prompt = renderTemplate(step.prompt, baseScope);
    const result = await spawnWorker(prompt, {
      ...common,
      schema: step.schema,
      label: step.label,
      isolation: step.isolation,
      // Opt-in warm executor (default 'cold'). A single-turn worker step with
      // executor:'resume' just persists its session for forward-compat; warm
      // reuse across stages is exercised by runPipeline(...,{warm:true}). 'fork'
      // degrades to cold with a log line.
      executor: step.executor
    });
    return { output: result.value, workerResults: [result] };
  }

  if (step.kind === "parallel") {
    const items = step.items || Array.from({ length: step.fanout || 1 }, (_, i) => ({ index: i }));
    const records = [];
    const thunks = items.map((item, i) => () =>
      spawnWorker(renderTemplate(step.prompt, { ...baseScope, item }), {
        ...common,
        schema: step.schema,
        label: `${step.label}#${i}`,
        isolation: step.isolation,
        executor: step.executor
      }).then((result) => {
        records[i] = result;
        return result.value;
      })
    );
    const output = await runParallel(thunks, { ctx });
    return { output, workerResults: records.filter(Boolean) };
  }

  if (step.kind === "verify") {
    const depResult = results.get(step.findings_from);
    const findingsSource = depResult ? depResult.output : undefined;
    let findings = getPath(findingsSource, step.findings_path);
    if (!Array.isArray(findings)) findings = findings === undefined || findings === null ? [] : [findings];
    const survivors = await adversarialVerify(findings, {
      ctx,
      skeptics: step.skeptics,
      lenses: step.lenses && step.lenses.length ? step.lenses : undefined,
      context: step.context ? renderTemplate(step.context, baseScope) : undefined,
      sandbox: step.sandbox,
      model: step.model,
      reasoningEffort: step.reasoning_effort,
      timeoutMs: step.timeout_ms,
      cwd: step.cwd,
      codex_bin: codexBin,
      codex_home: codexHomeValue,
      ...(transportOpts && transportOpts.transport && transportOpts.transport !== "exec"
        ? { transport: transportOpts.transport, transport_strict: transportOpts.transportStrict }
        : {}),
      ...(retryWorker || {}),
      phase: step.phase
    });
    return { output: survivors, workerResults: [] };
  }

  if (step.kind === "loop") {
    const collected = await loopUntilDry(
      (round, _ctx, state) => renderTemplate(step.prompt, {
        ...baseScope,
        round,
        seen: state.seenList || [],
        consecutive_dry: state.consecutiveDry || 0
      }),
      {
        ctx,
        schema: step.schema,
        dryRounds: step.dry_rounds,
        maxRounds: step.max_rounds,
        dedupeFindings: step.dedupe_findings,
        sandbox: step.sandbox,
        model: step.model,
        reasoningEffort: step.reasoning_effort,
        timeoutMs: step.timeout_ms,
        cwd: step.cwd,
        codex_bin: codexBin,
        codex_home: codexHomeValue,
        ...(transportOpts && transportOpts.transport && transportOpts.transport !== "exec"
          ? { transport: transportOpts.transport, transport_strict: transportOpts.transportStrict }
          : {}),
        ...(retryWorker || {}),
        phase: step.phase,
        label: step.label
      }
    );
    return { output: collected, workerResults: [] };
  }

  throw new Error(`Unknown step kind: ${step.kind}`);
}

// Build a journaled worker-record entry for a settled step, mirroring the
// runExplicitWorkflow worker shape so status/resume read it unchanged.
function stepRecordFromExecution(step, execution, durationMs) {
  const usage = sumUsageFromWorkers(execution.workerResults);
  const dropped = (r) => r && (r.status === "failed" || r.status === "cancelled");
  const anyFailed = execution.workerResults.some(dropped);
  const allFailed = execution.workerResults.length > 0 && execution.workerResults.every(dropped);
  const allCancelled =
    execution.workerResults.length > 0 && execution.workerResults.every((r) => r && r.status === "cancelled");
  return {
    index: step.index,
    id: step.id,
    step_id: step.id,
    kind: step.kind,
    depends_on: step.depends_on,
    title: step.label,
    label: step.label,
    phase: step.phase,
    model: step.model || null,
    reasoning_effort: step.reasoning_effort || null,
    status: allCancelled ? "cancelled" : allFailed ? "failed" : "completed",
    result: execution.output,
    value: execution.output,
    usage,
    duration_ms: durationMs,
    ...(anyFailed && !allFailed ? { partial: true } : {}),
    spec: {
      kind: step.kind,
      prompt: step.prompt,
      schema: step.schema,
      sandbox: step.sandbox,
      model: step.model || null,
      reasoning_effort: step.reasoning_effort || null,
      timeout_ms: step.timeout_ms,
      cwd: step.cwd,
      isolation: step.isolation || null,
      depends_on: step.depends_on
    }
  };
}

function stepFailureRecord(step, error) {
  return {
    index: step.index,
    id: step.id,
    step_id: step.id,
    kind: step.kind,
    depends_on: step.depends_on,
    title: step.label,
    label: step.label,
    phase: step.phase,
    model: step.model || null,
    reasoning_effort: step.reasoning_effort || null,
    status: "failed",
    result: null,
    value: null,
    error: error instanceof Error ? error.message : String(error)
  };
}

// Compile a declarative steps[] DAG and run it barrier-free, producing the same
// journaled workflow record shape as runExplicitWorkflow.
// Barrier-free topological scheduling, shared by runPipelineSpec and the
// script-scope dag() helper. stepPromise[id] resolves once the step executes,
// and a step's body only starts after Promise.all(its deps); the shared
// ctx/limiter keeps total concurrency globally bounded across branches. The
// resolved value is a Map(id -> { output }); `onStepRecord(step, record)`
// (optional) fires as each step settles so a caller can journal it.
async function runDagOnCtx(compiled, ctx, opts: RuntimeRecord = {}) {
  const { codexBin, codexHomeValue, retryWorker, transport, transportStrict, onStepRecord } = opts;
  const results = new Map(); // id -> { output }
  const stepPromise = new Map();
  for (const step of compiled) {
    const depPromises = step.depends_on.map((dep) => stepPromise.get(dep));
    const promise = Promise.all(depPromises).then(async () => {
      emitEvent(ctx, { type: "step.started", label: step.label, phase: step.phase, kind: step.kind });
      const startedAt = Date.now();
      let record;
      try {
        const execution = await executeStep(step, results, ctx, codexBin, codexHomeValue, retryWorker, {
          transport,
          transportStrict
        });
        results.set(step.id, { output: execution.output });
        record = stepRecordFromExecution(step, execution, Date.now() - startedAt);
      } catch (error) {
        // A render/validation error inside a step (e.g. unresolved token) drops
        // just this step; dependents that referenced it will then also fail.
        log(ctx, `pipeline: step "${step.id}" failed: ${error instanceof Error ? error.message : error}`, {
          step_id: step.id,
          reason: "step-error"
        });
        record = stepFailureRecord(step, error);
        results.set(step.id, { output: undefined });
      }
      emitEvent(ctx, { type: "step.completed", label: step.label, phase: step.phase, status: record.status });
      if (typeof onStepRecord === "function") onStepRecord(step, record);
      return record;
    });
    stepPromise.set(step.id, promise);
  }
  await Promise.all(Array.from(stepPromise.values()));
  return results;
}

async function runPipelineSpec(input: RuntimeRecord = {}) {
  const cwd = path.resolve(input.cwd || process.cwd());
  const baseSandbox = input.sandbox || "read-only";
  if (!VALID_SANDBOXES.has(baseSandbox)) {
    throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
  }
  const baseEffort = resolveReasoningEffort(input.reasoning_effort || input.reasoningEffort);
  if (baseEffort !== undefined && baseEffort !== null && !VALID_EFFORTS.has(baseEffort)) {
    throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
  }
  const timeoutMs =
    input.timeout_ms === undefined || input.timeout_ms === null
      ? DEFAULT_TIMEOUT_MS
      : Math.max(1_000, Math.floor(Number(input.timeout_ms)));
  const defaults: RuntimeRecord = {
    cwd,
    sandbox: baseSandbox,
    model: resolveModel(input.model),
    reasoning_effort: baseEffort,
    timeout_ms: timeoutMs,
    // Top-level executor cascades to every step that does not set its own.
    // Defaults to 'cold' so an omitted executor leaves the pipeline unchanged.
    executor:
      input.executor === "resume" || input.executor === "fork" || input.executor === "cold"
        ? input.executor
        : "cold"
  };

  // Compile + validate the whole DAG BEFORE any spawn. A bad spec throws here,
  // producing zero side effects / no orphaned worktrees.
  const { compiled } = compileSteps(input.steps, defaults);
  const retryOpts = resolveRetryInput(input);
  const budgetPolicy = resolvePipelineBudget(input);

  const identity = workflowIdentity(
    {
      ...input,
      labels: compiled.map((step) => step.label || step.id)
    },
    "Pipeline Run"
  );
  const id = identity.id;
  const ctx = createContext({
    workflowId: id,
    concurrency: input.concurrency,
    globalConcurrency: firstDefined(input.global_concurrency, input.globalConcurrency),
    budgetTokens: budgetPolicy.effective,
    maxAgents: input.max_agents,
    launchStaggerMs: input.launch_stagger_ms,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent: typeof input.on_event === "function" ? input.on_event : null,
    signal: input.signal
  });

  const now = new Date().toISOString();
  const codexBin =
    typeof input.codex_bin === "string" && input.codex_bin.trim() ? input.codex_bin.trim() : defaultCodexBin();
  const codexHomeValue =
    typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome();
  const transport = resolveTransport(firstDefined(input.transport, process.env.ULTRACODE_TRANSPORT));
  const transportStrict = resolveBool(firstDefined(input.transport_strict, input.transportStrict), false);

  const indexById = new Map(compiled.map((s, i) => [s.id, i]));
  const stepRecords: RuntimeRecord[] = compiled.map((step) => ({
    index: step.index,
    id: step.id,
    step_id: step.id,
    kind: step.kind,
    depends_on: step.depends_on,
    title: step.label,
    label: step.label,
    phase: step.phase,
    model: step.model || null,
    reasoning_effort: step.reasoning_effort || null,
    status: "pending"
  }));
  const workflow: RuntimeRecord = {
    id,
    name: identity.name,
    slug: identity.slug,
    status: "running",
    task: input.task || `${compiled.length}-step pipeline`,
    cwd,
    started_at: now,
    completed_at: null,
    controller: controllerSnapshot(now),
    options: {
      workers: compiled.length,
      sandbox: baseSandbox,
      timeout_ms: timeoutMs,
      model: defaults.model || null,
      reasoning_effort: baseEffort || null,
      concurrency: ctx.concurrency,
      global_concurrency: ctx.globalConcurrency,
      budget_tokens: ctx.budget.total,
      ...(budgetPolicy.floor === null
        ? {}
        : {
            budget_tokens_requested: budgetPolicy.requested,
            budget_floor_tokens: budgetPolicy.floor
          }),
      ...(budgetPolicy.strict ? { strict_budget: true } : {}),
      max_agents: ctx.maxAgents,
      launch_stagger_ms: ctx.launchStaggerMs,
      ui: shouldLaunchUi(input),
      pipeline: true,
      ...retryOpts.journal,
      ...transportJournal(transport, transportStrict)
    },
    state_path: statePathFor(id),
    phases: Array.from(new Set(compiled.map((s) => s.phase).filter(Boolean))),
    steps: stepRecords,
    workers: stepRecords,
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };
  await writeJson(workflow.state_path, workflow);
  const persister = makePersister(workflow, ctx);
  await attachWorkflowUi(workflow, ctx, input);
  if (workflow.ui) {
    persister.schedule();
    attachLiveJournalPersistence(workflow, ctx, persister);
  }

  // Barrier-free topological scheduling, shared with the script-scope dag()
  // helper via runDagOnCtx. Each step record is journaled into workflow.workers
  // as it settles.
  await runDagOnCtx(compiled, ctx, {
    codexBin,
    codexHomeValue,
    retryWorker: retryOpts.worker,
    transport,
    transportStrict,
    onStepRecord(step, record) {
      workflow.workers[indexById.get(step.id)] = record;
      persister.schedule();
    }
  });
  finalizeRecord(workflow, ctx);
  persister.schedule();
  await persister.flush();
  return workflow;
}

  return {
    compileSteps,
    renderTemplate,
    getPath,
    runDagOnCtx,
    runPipelineSpec
  };
};
