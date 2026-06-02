#!/usr/bin/env node
"use strict";

// ===========================================================================
// ultracode-script-runner — opt-in imperative JS workflow-script runner
//
// This is the Codex analogue of Claude Code's Workflow tool: it binds the
// engine's existing orchestration primitives (spawnWorker / runParallel /
// runPipeline / loopUntilDry / adversarialVerify) into a small, ergonomic
// "script scope" so an operator can express a multi-agent workflow as plain
// imperative JavaScript instead of a declarative DAG.
//
//   await runScript({ source: `
//     phase("scan");
//     const hits = await parallel(files.map(f => () => agent("inspect " + f)));
//     return hits.filter(Boolean);
//   ` })
//
// ---------------------------------------------------------------------------
// Execution model.
// ---------------------------------------------------------------------------
// runScript() compiles the workflow body with AsyncFunction in the host CLI
// process. The transform is ergonomic: it provides top-level await, captures a
// top-level return value, binds Ultracode primitives, and journals script output
// into the usual run record under CODEX_HOME/ultracode/runs.
// ===========================================================================

const fs = require("fs/promises");
const path = require("path");

const { transformSource } = require("./script-source-transform");
const { attachWorkflowUi, shouldLaunchUi } = require("./ultracode-ui-launcher");

// Top-level require of the engine is intentional and safe: the engine must
// NOT top-level require this runner (it uses a lazy require wrapper), so there
// is no require cycle. See ultracode-engine.js runScript re-export.
const engine = require("./ultracode-engine");

// ---------------------------------------------------------------------------
// Local persistence helper. Script ids come from the engine's workflowIdentity()
// helper so every Ultracode surface journals the same readable id/name shape.
// ---------------------------------------------------------------------------

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeScriptPersister(record, ctx) {
  let chain = Promise.resolve();
  return {
    schedule() {
      const snapshot = JSON.parse(JSON.stringify(record));
      chain = chain
        .then(() => writeJson(record.state_path, snapshot))
        .catch((error) => {
          engine.log(ctx, `Failed to persist script workflow state: ${error.message}`, { reason: "persist-error" });
          process.stderr.write(`[ultracode] script state persist error: ${error.message}\n`);
        });
      return chain;
    },
    flush() {
      return chain;
    }
  };
}

function scriptPendingWorkerRecord(meta, fallbackIndex) {
  const index = meta && Number.isInteger(meta.index) ? meta.index : fallbackIndex;
  const id = meta && meta.id ? meta.id : `worker-${index + 1}`;
  const label = (meta && meta.label) || id;
  return {
    index,
    id,
    step_id: (meta && meta.step_id) || id,
    title: (meta && meta.title) || label,
    label,
    phase: (meta && meta.phase) || null,
    status: "pending",
    ...(meta && meta.spec ? { spec: meta.spec } : {})
  };
}

function scriptWorkerRecordFromResult(meta, result, fallbackIndex) {
  const base = scriptPendingWorkerRecord(meta, fallbackIndex);
  return engine.workerRecordFromResult(base, result);
}

// ---------------------------------------------------------------------------
// Source transform.
//
// The script body is compiled with the AsyncFunction constructor whose NAMED
// PARAMETERS are the bound API. This gives us: top-level `await`, a captured
// top-level `return` value (becomes record.result), and host-level try/catch
// journaling of a throwing/syntactically-broken script. Orphan (un-awaited)
// promise rejections — which fire outside that try/catch — are separately
// captured by a scoped process listener and surfaced as record.warnings, so a
// fire-and-forget rejection can never crash a long-lived host. (A genuinely
// stray synchronous throw on a later timer tick — an uncaughtException — is the
// one residual that is NOT contained; that matches normal Node script execution.)
//
// ES module sugar is tolerated so a `.workflow.js` file can be authored with
// editor module support. The transform is lexical, so nested workflow source
// strings keep their own `export default` until the nested runner compiles them:
//   - `export default <expr>` -> `return <expr>`.
//   - leading `export const|let|var|async|function|class` -> the bare decl.
//
// A `"use strict";` prelude is prepended so an undeclared assignment throws
// ("x is not defined") instead of silently leaking a host global.
// ---------------------------------------------------------------------------

// AsyncFunction constructor (function scope, not a fresh global).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// The ordered list of bound-scope parameter names. Kept as a single source of
// truth so the function signature and the call arguments never drift apart.
const SCOPE_PARAMS = [
  "agent",
  "spawnWorker",
  "parallel",
  "pipeline",
  "loopUntilDry",
  "adversarialVerify",
  "log",
  "phase",
  "workflow",
  "budget",
  "args",
  "ctx",
  "WORKER_SCHEMA",
  "VERDICT_SCHEMA"
];

// ---------------------------------------------------------------------------
// Bound script scope. ctx is auto-injected into every primitive so the user
// never has to thread it. `currentPhase` is closure-tracked and used as the
// default phase for worker-spawning primitives.
// ---------------------------------------------------------------------------

function buildScope(ctx, input) {
  let currentPhase = null;

  // Defaults shared by every spawn: where the codex bin/home live and the cwd.
  // These come from the runScript input so a script never has to repeat them.
  const spawnDefaults = {};
  if (typeof input.codex_bin === "string" && input.codex_bin.trim()) {
    spawnDefaults.codex_bin = input.codex_bin.trim();
  }
  if (typeof input.codex_home === "string" && input.codex_home.trim()) {
    spawnDefaults.codex_home = input.codex_home.trim();
  }
  if (input.cwd) spawnDefaults.cwd = input.cwd;

  // spawnWorker(prompt, opts?) -> FULL engine record {status,value,usage,...}.
  // ctx + phase defaults are injected; never throws (engine resolves a failure
  // to a {status:'failed'} record).
  function spawnWorker(prompt, opts = {}) {
    return engine.spawnWorker(prompt, {
      ...spawnDefaults,
      phase: currentPhase,
      ...opts,
      ctx
    });
  }

  // agent(prompt, opts?) -> worker.value on completion, else null (the engine
  // already logged the failure). The ergonomic happy-path primitive.
  async function agent(prompt, opts = {}) {
    const record = await spawnWorker(prompt, opts);
    return record && record.status === "completed" ? record.value : null;
  }

  // parallel(thunks) -> barrier gather; a throwing thunk degrades to null.
  function parallel(thunks) {
    return engine.runParallel(thunks, { ctx });
  }

  // pipeline(items, ...stages) -> VARIADIC. engine.runPipeline takes stages as
  // an ARRAY; collecting the rest params here is MANDATORY. Passing stages
  // positionally would silently null every item (opts lands on a stage fn so
  // ctx becomes null and even the drop-log is a no-op). Each stage receives
  // (prev, item, index, ctx).
  function pipeline(items, ...stages) {
    return engine.runPipeline(items, stages, { ctx });
  }

  function loopUntilDry(makePrompt, opts = {}) {
    return engine.loopUntilDry(makePrompt, { ...spawnDefaults, phase: currentPhase, ...opts, ctx });
  }

  function adversarialVerify(findings, opts = {}) {
    return engine.adversarialVerify(findings, { ...spawnDefaults, phase: currentPhase, ...opts, ctx });
  }

  // log(message, data?) routes through the engine's narrator so script lines
  // land in ctx.events alongside primitive logs.
  function log(message, data) {
    return engine.log(ctx, message, data);
  }

  // phase(title) sets the closure-tracked currentPhase used as the default
  // phase for subsequent agent()/spawnWorker() calls.
  function phase(title) {
    currentPhase = typeof title === "string" && title.trim() ? title.trim() : null;
    engine.log(ctx, `phase: ${currentPhase || "(none)"}`, { phase: currentPhase });
    return currentPhase;
  }

  // workflow(pathOrSource, args?) -> one-level nested runScript, guarded by
  // ULTRACODE_DEPTH. Refuses (and logs) beyond depth 1 with a clear, explicit
  // throw rather than silently no-op'ing. The nested run inherits concurrency/
  // budget/cap knobs but creates its own ctx at depth+1 (the engine pattern).
  function workflow(pathOrSource, workflowArgs) {
    const depth = Number(process.env.ULTRACODE_DEPTH || 0);
    if (depth >= 1) {
      engine.log(ctx, "nested script workflow refused: depth limit reached", {
        reason: "maxDepth",
        depth
      });
      throw new Error("nested script workflows beyond depth 1 are not supported");
    }
    // A bare string with no newline and an existing-looking path is treated as
    // a path; anything containing a newline is inline source. Callers can be
    // explicit by passing { path } / { source }.
    const nested = {
      args: workflowArgs,
      cwd: input.cwd,
      concurrency: input.concurrency,
      budget_tokens: input.budget_tokens,
      max_agents: input.max_agents,
      launch_stagger_ms: input.launch_stagger_ms,
      max_retries: input.max_retries,
      base_delay_ms: input.base_delay_ms,
      max_delay_ms: input.max_delay_ms,
      retry_jitter: input.retry_jitter,
      signal: ctx.signal,
      on_event: ctx.onEvent || undefined,
      codex_bin: spawnDefaults.codex_bin,
      codex_home: spawnDefaults.codex_home
    };
    if (pathOrSource && typeof pathOrSource === "object") {
      Object.assign(nested, pathOrSource);
    } else if (typeof pathOrSource === "string" && pathOrSource.includes("\n")) {
      nested.source = pathOrSource;
    } else {
      nested.path = pathOrSource;
    }
    return runScript(nested);
  }

  return {
    agent,
    spawnWorker,
    parallel,
    pipeline,
    loopUntilDry,
    adversarialVerify,
    log,
    phase,
    workflow,
    budget: ctx.budget,
    args: input.args,
    ctx,
    WORKER_SCHEMA: engine.WORKER_SCHEMA,
    VERDICT_SCHEMA: engine.VERDICT_SCHEMA
  };
}

// ---------------------------------------------------------------------------
// runScript(input) -> Promise<workflowRecord>
// ---------------------------------------------------------------------------

async function runScript(input = {}) {
  // XOR-validate source|path: exactly one is required.
  const hasSource = typeof input.source === "string" && input.source.length > 0;
  const hasPath = typeof input.path === "string" && input.path.trim().length > 0;
  if (hasSource && hasPath) {
    throw new Error("runScript: provide exactly one of `source` or `path`, not both.");
  }
  if (!hasSource && !hasPath) {
    throw new Error("runScript: one of `source` or `path` is required.");
  }

  const cwd = path.resolve(input.cwd || process.cwd());
  // Read the file by its contents only (dirname-independent): the script body
  // does not depend on where the file lives on disk.
  const source = hasSource ? input.source : await fs.readFile(path.resolve(input.path), "utf8");

  const identity = engine.workflowIdentity(input, "Script Run");
  const id = identity.id;
  let record = null;
  let persister = null;
  let ctx = null;
  const workersById = new Map();
  const schedulePersist = () => {
    if (!record || !persister || !ctx) return;
    record.events = ctx.events;
    record.aggregate_usage = ctx.usageTotals;
    persister.schedule();
  };
  ctx = engine.createContext({
    workflowId: id,
    concurrency: input.concurrency,
    budgetTokens: input.budget_tokens,
    maxAgents: input.max_agents,
    launchStaggerMs: input.launch_stagger_ms,
    depth: Number(process.env.ULTRACODE_DEPTH || 0),
    onEvent:
      typeof input.on_event === "function"
        ? (event) => {
            try {
              input.on_event(event);
            } finally {
              schedulePersist();
            }
          }
        : () => schedulePersist(),
    onWorkerPending: (meta) => {
      if (!record || !meta) return;
      const pending = scriptPendingWorkerRecord(meta, record.workers.length);
      workersById.set(pending.id, pending.index);
      record.workers[pending.index] = pending;
      schedulePersist();
    },
    onWorkerRecord: (result, meta) => {
      if (!record) return;
      const index =
        meta && meta.id && workersById.has(meta.id) ? workersById.get(meta.id) : record.workers.length;
      const updated = scriptWorkerRecordFromResult(meta, result, index);
      workersById.set(updated.id, index);
      record.workers[index] = updated;
      schedulePersist();
    },
    signal: input.signal
  });

  const startedAt = new Date().toISOString();
  const statePath = engine.statePathFor(id);

  record = {
    id,
    name: identity.name,
    slug: identity.slug,
    kind: "script",
    status: "running",
    started_at: startedAt,
    completed_at: null,
    duration_ms: 0,
    cwd,
    options: {
      concurrency: ctx.concurrency,
      budget_tokens: ctx.budget.total,
      max_agents: ctx.maxAgents,
      launch_stagger_ms: ctx.launchStaggerMs,
      ui: shouldLaunchUi(input),
      max_retries: input.max_retries === undefined ? null : input.max_retries,
      base_delay_ms: input.base_delay_ms === undefined ? null : input.base_delay_ms,
      max_delay_ms: input.max_delay_ms === undefined ? null : input.max_delay_ms,
      retry_jitter: input.retry_jitter === undefined ? null : input.retry_jitter
    },
    state_path: statePath,
    // Script records are not step-resumable, but they do journal the dynamic
    // workers they spawned so status can show live progress and post-run details.
    workers: [],
    result: null,
    events: ctx.events,
    aggregate_usage: ctx.usageTotals
  };

  // Persist a "running" snapshot up-front so an interrupted run still leaves a
  // readable record (mirrors runWorkflow).
  await writeJson(statePath, record);
  persister = makeScriptPersister(record, ctx);
  await attachWorkflowUi(record, ctx, input);
  if (record.ui) schedulePersist();

  const scope = buildScope(ctx, { ...input, cwd });

  // Capture orphan (un-awaited) promise rejections from the script. A
  // fire-and-forget rejection (e.g. `Promise.reject(x)` with no await) fires on
  // a later tick — outside the try/await below — and would otherwise become a
  // process-level 'unhandledRejection' that crashes the host process. A scoped
  // listener installed only for the run both suppresses
  // Node's default crash and surfaces the rejection as a record warning.
  // (Under rare concurrent runs every listener sees every rejection; that
  // over-reports but never crashes.)
  const orphanRejections = [];
  const onUnhandledRejection = (reason) => {
    orphanRejections.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on("unhandledRejection", onUnhandledRejection);

  // Build the async body. A SyntaxError here is caught below and journaled as
  // status:'failed' so a broken script never crashes the host.
  let result = null;
  let error = null;
  try {
    let fn;
    try {
      fn = new AsyncFunction(...SCOPE_PARAMS, transformSource(source));
    } catch (compileError) {
      // SyntaxError from the AsyncFunction constructor.
      throw compileError;
    }
    const callArgs = SCOPE_PARAMS.map((name) => scope[name]);
    result = await fn(...callArgs);
  } catch (runError) {
    error = runError;
  } finally {
    // Yield one macrotask so any orphan rejection scheduled during the run is
    // delivered while the listener is still installed, then stop listening.
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }

  const completedAt = new Date().toISOString();
  record.completed_at = completedAt;
  record.duration_ms = Date.parse(completedAt) - Date.parse(startedAt);
  // aggregate_usage is the same object ctx mutated during the run; snapshot it
  // into the record explicitly to match the engine's finalized shape.
  record.aggregate_usage = ctx.usageTotals;
  record.events = ctx.events;
  if (error) {
    record.status = "failed";
    record.result = null;
    record.error = error instanceof Error ? error.message : String(error);
  } else {
    record.status = "completed";
    record.result = result === undefined ? null : result;
  }

  // A script that returned a value but also leaked an un-awaited rejection is
  // still 'completed' (its result is valid), but the leak is surfaced loudly as
  // a warning + a log event rather than silently swallowed.
  if (orphanRejections.length > 0) {
    record.warnings = orphanRejections.map((message) => `unhandled promise rejection: ${message}`);
    for (const message of orphanRejections) {
      engine.log(ctx, `script emitted an unhandled promise rejection: ${message}`, { reason: "unhandled-rejection" });
    }
    record.events = ctx.events;
  }

  // Final write. Wrapped so a serialization failure (e.g. a non-JSON-able
  // script return value) still journals a useful failure instead of throwing
  // out of runScript.
  try {
    persister.schedule();
    await persister.flush();
  } catch (writeError) {
    record.status = "failed";
    record.result = null;
    record.error = `result could not be journaled: ${writeError.message}`;
    // Best-effort second write of the now-sanitized record.
    try {
      await writeJson(statePath, record);
    } catch {
      /* nothing more we can do; return the in-memory record */
    }
  }

  return record;
}

module.exports = { runScript, transformSource };
