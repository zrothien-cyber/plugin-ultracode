# <img src="assets/icon.png" width="32" height="32" alt="Ultracode icon"> Ultracode

A Codex CLI plugin that fans out `codex exec` subprocess workers for deep code investigation, planning, and
review — and brings the orchestration model of **Claude Code's Workflow tool** to Codex.

Workers run as real `codex exec` subprocesses (read-only by default), return schema-validated structured
findings to the parent thread, and the parent synthesizes and implements so the meaningful edits stay visible
in the Codex app/TUI.

## Pair with Codex goals

For complex Ultracode work, the parent Codex thread should usually set its own Codex goal before starting the
fan-out. A goal is the parent thread's persistence guard: Codex keeps working until it explicitly marks that
goal complete or blocked, which helps prevent an Ultracode-assisted investigation from ending after the worker
summary but before synthesis, edits, and verification are truly done.

Use the goal for the top-level outcome, not for individual workers. Ultracode workers run in separate Codex
threads; they may have their own local state, but they are not responsible for clearing the parent task. The
parent should create the goal, run Ultracode as needed, synthesize the worker evidence, apply changes, verify the
result, and only then clear the goal.

## Install

Add the Just Every plugin marketplace, then install Ultracode from it:

```bash
codex plugin marketplace add just-every/plugins
codex plugin add ultracode@just-every
```

## Components

| Path | Role |
| --- | --- |
| `scripts/ultracode-engine.js` | Orchestration engine: worker spawning, primitives, usage/budget, journaled state. No npm deps. |
| `scripts/ultracode-script-runner.js` | Imperative [Workflow scripts](#workflow-scripts) runner (`runScript`): binds the engine primitives into a bound script scope, snapshots the source, and supports explicit cached-call resume. |
| `scripts/workflow-definitions.js` / `scripts/claude-workflow-compat.js` | Claude-style saved workflow discovery, `meta` extraction, compatibility diagnostics, and `.claude/workflows` persistence. |
| `scripts/ultracode-ui-launcher.js` / `scripts/ultracode-ui-server.js` | Local dashboard launcher and dependency-free HTTP server over the persisted workflow journal. |
| `scripts/app-server-client.js` | Dependency-free `codex app-server` JSON-RPC client for the opt-in `transport: 'app-server'` worker path (handshake, lenient bare-JSON-RPC framing, usage normalization). |
| `scripts/ultracode-cli.js` | CLI over the same engine (`plan` / `run` / `pipeline` / `resume` / `status` / `script`). |
| `ui/` | React dashboard assets served from the installed plugin cache; includes pinned browser React files so no runtime `npm install` is needed. |
| `skills/ultracode/SKILL.md` | Model-facing decision layer (when/scale/surface/patterns index). Always loaded. |
| `skills/ultracode/references/` | On-demand depth pulled by the model: `quality-patterns.md`, `cookbook.md` (runnable skeletons), `cli.md` (full flag/API reference). |

## Claude Workflow parity

Claude Code's Workflow tool orchestrates subagents with `agent()`, `pipeline()`, `parallel()`, `phase()`,
`log()`, `budget`, schema-forced output, concurrency caps, and resume. Ultracode now mirrors that model on top
of `codex exec` subprocesses:

| Claude Workflow feature | Ultracode equivalent | Status |
| --- | --- | --- |
| `agent(prompt, {schema})` — arbitrary prompt + per-agent schema | `spawnWorker(prompt, opts)` / `workers_spec[]` | ✅ |
| Validated structured output + retry on mismatch | `validateAgainstSchema` + `schemaRetries` (default 1) | ✅ |
| Raw-text return (no schema) | `schema: null` | ✅ |
| `parallel(thunks)` — barrier, throw → null | `runParallel(thunks, {ctx})` / CLI `pipeline` `kind:parallel` | ✅ |
| `pipeline(items, stages)` — barrier-free streaming | `runPipeline(items, stages, {ctx})` / CLI `pipeline` DAG | ✅ |
| Concurrency cap `min(16, cores-2)` | shared `createLimiter` via `ctx` | ✅ |
| Lifetime agent cap (1000) | `ctx.maxAgents` (counts subprocess spawns incl. schema retries) | ✅ |
| `budget` — total / spent() / remaining() | `ctx.budget` + `budget_tokens` gate (best-effort soft cap, see below), cross-worker usage aggregation | ✅ |
| `log()` narrator + no-silent-caps | `log()` + `events[]` + `--progress` / `on_event` | ✅ |
| `phase()` grouping | per-worker `phase`, `record.phases` | ✅ |
| Resume (reuse completed; re-run failed/missing/forced) | `resumeWorkflow` / CLI `resume`, journaled state keyed by `step_id` — re-runs only failed, missing, or `force_steps` entries (no automatic content-change detection or downstream cascade) | ◐ partial |
| Quality: loop-until-dry | `loopUntilDry(makePrompt, opts)` / CLI `pipeline` `kind:loop` | ✅ |
| Quality: adversarial / perspective-diverse verify | `adversarialVerify(findings, {skeptics, lenses})` / CLI `pipeline` `kind:verify` | ✅ |
| `isolation: 'worktree'` for parallel writers | `spawnWorker({isolation:'worktree'})` (git worktree + diff capture) | ✅ |
| `args` threaded to stages | `args` in the script scope + stage callbacks receive `(prev, item, index, ctx)` | ✅ |
| Imperative `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `budget` script | **`ultracode-cli.js script`** (the [_Workflow scripts_](#workflow-scripts) runner) | ✅ |
| `workflow()` nested sub-step | one-level nesting enforced via `ULTRACODE_DEPTH` depth guard (deeper nesting refused + logged) | ◐ partial |
| Saved `.claude/workflows/*.js` commands | CLI `workflow list/show/run/save/update/delete`, project before user before `$CODEX_HOME/ultracode/workflows` | ✅ |
| `export const meta = { name, description, phases }` | parsed, preserves phase `detail`, visible in UI, and used for named workflow identity | ✅ |
| `export async function run(context)` | invoked automatically in Claude-compat mode; `context.args`, `context.cwd`, `context.workflow`, `context.phase`, `context.log`, `context.budget` are bound | ✅ |
| Workflow primitive imports | imports from `claude/workflow(s)` / `@anthropic-ai/claude-code/workflow(s)` are rewritten to the bound primitives, including aliases and namespace imports | ✅ |
| `resumeFromRunId` cached agent calls | `resume_from_run_id` reuses completed script `agent()`/`spawnWorker()` calls when prompt+options hash matches | ◐ partial |

**Reachability.** Every primitive above is exported from `scripts/ultracode-engine.js` and is now reachable
through four layered surfaces, in increasing order of expressiveness:

1. **CLI `run`** — the fixed-role and `workers_spec` flat fan-out (all peers at once, no data flow).
2. **CLI `pipeline`** — a declarative `steps[]` DAG that compiles `parallel` / `pipeline` / `verify` / `loop`
   into the engine primitives with token-substitution edges between steps.
3. **CLI `script`** — the imperative [_Workflow scripts_](#workflow-scripts)
   runner: plain async JavaScript with `agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `budget`, and
   `args` bound into scope. This is the closest analogue to Claude Code's in-process Workflow tool and is the only
   surface that combines the primitives with arbitrary host-side control flow and reductions.
4. **CLI `workflow`** — saved Claude-style workflow definitions under `.claude/workflows`, `~/.claude/workflows`,
   or `$CODEX_HOME/ultracode/workflows`, with strict compatibility diagnostics before execution.

The execution paths run through the same shared limiter, budget, and progress sink. The `pipeline()` /
`parallel()` / `args`-to-stages rows that were previously engine-API-only are now reachable end-to-end via the
script runner.

### Declarative pipeline DAG (`pipeline`)

`pipeline` takes a `steps[]` array describing a directed acyclic graph. Each step has a unique `id`, a
`kind` (`worker` | `parallel` | `verify` | `loop`, default `worker`), a `prompt` template, and optional
`depends_on` edges. Scheduling is **barrier-free**: a step starts the instant *its own* `depends_on` resolve,
independent of unrelated branches, while the shared context keeps concurrency + token budget globally bounded.
The whole DAG is validated **before any spawn** — duplicate id, unknown dependency, self/cross-reference, and
cycles (Kahn pre-pass) all throw with a clear error and zero side effects.

Because workers are separate `codex exec` subprocesses that share no memory, cross-stage data is injected by
rendering tokens into the dependent prompt just before its spawn:

| Token | Resolves to |
| --- | --- |
| `{{steps.<id>.output}}` | the full output of dependency `<id>` (pretty JSON if an object, else raw string) |
| `{{steps.<id>.output.<dot.path>}}` | a drill-in (e.g. `{{steps.review.output.findings}}`) |
| `{{steps.<id>.summary}}` | `output.summary` of dependency `<id>` |
| `{{round}}` | the current round index inside a `loop` step |
| `{{item.<key>}}` | a field of the current item inside a `parallel` step |

A step may only reference ids listed in its own `depends_on` (compile-time enforced), and any unresolved token
throws rather than emitting a blank. Per-kind fields: `verify` adds `findings_from` / `findings_path` (default
`findings`) / `skeptics` (default 3) / `lenses` / `context`; `loop` adds `dry_rounds` (default 2) / `max_rounds`
(default 10) and exposes `{{round}}`; `parallel` adds `fanout` (int) **or** `items` (array, each exposed as
`{{item.<key>}}`). Pipeline records include a top-level `steps[]` array of step-oriented records and keep
`workers[]` as the same journaled list for existing `status` / `resume` readers. Completed worker/step records
carry both `result` and `value` aliases for their output.

> Pipeline resume is **partial** (same caveat as CLI `resume`): a re-run leaf replays its already-rendered
> prompt faithfully, but re-running an upstream step does **not** re-render or cascade to downstream dependents.

Two intentional behavioral differences from Claude's in-process Workflow tool:

- **Subprocess token budgeting.** Ultracode workers are separate `codex exec` subprocesses, so cross-worker
  budgeting depends on Codex reporting `turn.completed.usage` (it does). The `budget_tokens` gate is a
  best-effort **soft** cap: it is checked when a worker is admitted, with usage accounted after each worker
  completes, so with concurrency _N_ up to _N_ in-flight workers (plus their schema retries) can finish after
  the budget is logically exhausted. Worst-case overspend is bounded by roughly `concurrency × per-worker cost`.
- **No token streaming.** Worker tokens are not streamed live to the parent. The wins are CLI `--progress`,
  accurate on-disk journaled status, the local dashboard launched for active runs, and an events log the parent
  reads via CLI `status`.

## Usage

### CLI

Default fixed-role fan-out:

```bash
node scripts/ultracode-cli.js plan   --task "..." --workers 3
node scripts/ultracode-cli.js run    --task "..." --workers 4 --concurrency 4 --budget-tokens 500000 --progress
```

Arbitrary per-worker fan-out with custom schemas + a token budget:

```bash
node scripts/ultracode-cli.js run    --workers-spec '[{"prompt":"...","label":"a"}]' --progress
```

Declarative DAG: review, then adversarially verify its findings:

```bash
node scripts/ultracode-cli.js pipeline --steps '[{"id":"a","prompt":"..."},{"id":"b","prompt":"use {{steps.a.summary}}","depends_on":["a"]}]' --progress
```

Resume, status, saved workflow definitions, and imperative Workflow scripts:

```bash
node scripts/ultracode-cli.js resume --workflow-id ultra-... --force-steps '["1"]'
node scripts/ultracode-cli.js status --workflow-id ultra-...
node scripts/ultracode-cli.js script <path> --args '{"files":["a.js"]}'   # imperative Workflow script (see below)
node scripts/ultracode-cli.js workflow list
node scripts/ultracode-cli.js workflow run deep-research --args '{"topic":"..."}'
node scripts/ultracode-cli.js workflow save deep-research --workflow-id ultra-...
```

### Run dashboard

`run`, `pipeline`, `resume`, and `script` start a local dashboard server by default. The first running journal
snapshot is written, then the dashboard URL is stored on `record.ui.url` and emitted as a `ui.ready` progress
event:

```bash
node scripts/ultracode-cli.js run --task "..." --workers 4 --progress
# [ultracode] ui.ready UI ready at http://127.0.0.1:<port>/workflow/ultra-...
```

The UI reads the same `$CODEX_HOME/ultracode/runs/<id>.json` records as `status`. It shows the workflow status,
agent/step nodes, phases, dependency lines, last messages, events, prompts, errors, and output details. The
server binds to `127.0.0.1`, reuses one process per `CODEX_HOME`, and exits after an idle timeout.

Disable it with `--no-ui` or `ULTRACODE_UI=0`:

```bash
ULTRACODE_UI=0 node scripts/ultracode-cli.js pipeline --steps '[...]'
node scripts/ultracode-cli.js script ./workflow.js --no-ui
```

Ultracode product code does not directly control the Codex in-app browser. It emits the dashboard URL through
the journal/progress path; a parent Codex thread with the Browser plugin available should open that URL in the
in-app browser at the start of the session.

### Scripted orchestration

```js
const uc = require("./scripts/ultracode-engine");
const ctx = uc.createContext({ concurrency: 4, budgetTokens: 500_000, onEvent: (e) => console.error(e.type) });

// pipeline: each finding verifies as soon as its review completes (no barrier between stages)
const results = await uc.runPipeline(
  [{ key: "bugs" }, { key: "perf" }],
  [
    (dim) => uc.spawnWorker(`Review for ${dim.key} issues.`, { ctx, schema: uc.WORKER_SCHEMA }),
    (review) => uc.adversarialVerify(review.value.findings, { ctx, skeptics: 3 }),
  ],
  { ctx }
);
```

## Workflow scripts

`node scripts/ultracode-cli.js script` runs an **imperative workflow script** — the Codex analogue of Claude
Code's in-process Workflow tool. Instead of a declarative `steps[]` DAG, you write plain async JavaScript and
the engine's orchestration primitives are pre-bound into the script scope, so a multi-agent workflow reads like
ordinary code with `await`, `map`/`filter`/`sort`, and arbitrary host-side reductions between agent calls.

### API surface

`runScript(input)` — exported from `scripts/ultracode-script-runner.js` — resolves to a journaled record. `input`:

| Field | Meaning |
| --- | --- |
| `source` **xor** `path` | the script body inline, **or** a path to a `.js`/`.workflow.js` file. Exactly one is required (both/neither throws). `path` is read by **contents** (dirname-independent). |
| `args` | arbitrary object exposed to the script as the bound `args`. |
| `resume_from_run_id` / `resumeFromRunId` | explicit cached-call resume: completed prior script worker calls are reused only when their prompt+options cache key matches. |
| `claude_compat` / `claudeCompat` | enables strict Claude saved-workflow diagnostics and adapters before execution: allowed workflow imports are rewritten, `run(context)` is invoked, and direct workflow-side filesystem/shell/host access fails before workers spawn. |
| `cwd` | workspace directory for child workers. |
| `concurrency` / `budget_tokens` / `max_agents` / `launch_stagger_ms` | the shared limiter / soft token cap / lifetime spawn cap / tiny per-workflow subprocess launch stagger (same semantics as CLI `run`). |
| `max_retries` / `base_delay_ms` / `max_delay_ms` / `retry_jitter` | journaled into `options`. |
| `signal` / `on_event` | abort signal and progress sink (wired by the CLI's Ctrl-C and `--progress`). |
| `codex_bin` / `codex_home` | spawn defaults threaded into every agent. |

**Bound script scope** (`ctx` is auto-injected into every primitive — you never pass it):

| Binding | Behavior |
| --- | --- |
| `agent(prompt, opts?)` | spawns one worker and returns its `value` on completion, else `null` (the failure is already logged). The ergonomic happy-path primitive. |
| `spawnWorker(prompt, opts?)` | the raw engine call returning the full `{status, value, result, usage, thread_id, ...}` record (advanced). |
| `parallel(thunks)` | barrier gather; a throwing thunk degrades to `null`. |
| `pipeline(items, ...stages)` | **variadic** — each stage is a positional argument and receives `(prev, item, index, ctx)`; barrier-free streaming. |
| `loopUntilDry(makePrompt, opts?)` | keep spawning finders until K dry rounds / budget / lifetime cap. |
| `adversarialVerify(findings, opts?)` | keep only findings that survive a majority refute vote. |
| `log(message, data?)` | narrator line into `events[]`. |
| `phase(title)` | sets a closure-tracked phase used as the default `phase` for subsequent worker-spawning primitives. |
| `workflow(pathOrSource, args?)` | one-level **nested** `runScript`, guarded by `ULTRACODE_DEPTH`; a bare name resolves saved workflow definitions by the same precedence as `workflow run`; beyond depth 1 it throws `nested script workflows beyond depth 1 are not supported`. |
| `context` | Claude-compatible object with `args`, `cwd`, `workflow`, `phase`, `log`, and `budget`. It does not expose filesystem or shell helpers. |
| `orchestrator` | namespace alias for the bound primitives (`agent`, `parallel`, `pipeline`, `phase`, `log`, `workflow`, etc.). |
| `budget` | `{ total, spent(), remaining() }`. |
| `args` | the `input.args` object. |
| `ctx` | the shared context (advanced). |
| `WORKER_SCHEMA` / `VERDICT_SCHEMA` | the engine schemas. |

A script may use top-level `await` and a top-level `return` (the returned value becomes `record.result`). ES
module sugar is tolerated by a small source transform: only top-level `export default <expr>` becomes the captured
return value, and a leading top-level `export const|let|var|async|function|class` is stripped to the bare
declaration (so a `.workflow.js` file is editor-friendly). Nested workflow source strings keep their own
`export default` for the nested runner. A `"use strict";` prelude is prepended as hygiene (an undeclared
assignment throws instead of leaking a host global). **Note:** because the body is wrapped in an `AsyncFunction`,
a journaled `error` line/position is offset from the original file — the message is still accurate but line
numbers will not match the source.

### Returned record

```jsonc
{ "id": "ultra-<stamp>-<hex>", "kind": "script", "status": "completed" /* | "failed" */,
  "started_at": "...", "completed_at": "...", "duration_ms": 0, "cwd": "...",
  "options": { "concurrency": 4, "budget_tokens": null, "max_agents": 1000, "launch_stagger_ms": 25,
               "max_retries": null, "base_delay_ms": null, "max_delay_ms": null, "retry_jitter": null },
  "state_path": "$CODEX_HOME/ultracode/runs/ultra-....json",
  "script_path": "$CODEX_HOME/ultracode/scripts/ultra-....workflow.js",
  "source_path": "/path/to/source.workflow.js",
  "source_hash": "sha256...",
  "meta": { "name": "Example", "description": "...", "phases": [{ "title": "Inspect", "detail": "..." }] },
  "workers": [              // dynamic workers spawned by agent/helper primitives
    { "id": "worker-1", "status": "completed", "phase": "inspect", "cache_key": "...", "result": {}, "value": {} }
  ],
  "result": { /* the script's return value */ },
  "events": [ /* narrator log */ ],
  "aggregate_usage": { /* cross-worker token totals */ },
  "error": "<message, only when status:failed>" }
```

A throwing or syntactically broken script never crashes the host: execution is wrapped in `try`/`catch`, so the
record is journaled with `status: "failed"`, the `error` message, and the partial `events` written so far. The
record is read by CLI `status` (and `readWorkflow`) unchanged; CLI `resume` degrades to a clean
"nothing to resume" message because an arbitrary script body is not step-resumable.

Script runs now snapshot the source under `$CODEX_HOME/ultracode/scripts/` and record the original source path,
`source_hash`, parsed Claude `meta`, and optional saved-workflow `definition_ref`. When `resume_from_run_id` is
provided, unchanged completed `agent()` / `spawnWorker()` calls are returned from the prior run record without
spawning a new Codex worker. This is intentionally narrower than full arbitrary-JS resume: changed call keys run
live, and uncheckpointed host-side JavaScript still executes normally.

## Saved workflow definitions

`workflow` commands discover Claude-style JavaScript workflows in this order:

1. `<cwd>/.claude/workflows/*.js`
2. `~/.claude/workflows/*.js`
3. `$CODEX_HOME/ultracode/workflows/*.js`

Project workflows win when names collide. `export const meta = { name, description, phases }` is parsed as a
pure object literal and preserved in run records, including simple scalar fields on phase objects such as
`detail`. In Claude-compat mode, allowed workflow-primitive imports are rewritten to the bound runtime,
`export async function run(context)` is invoked automatically, `orchestrator.*` maps to the primitive namespace,
and unsupported direct workflow-side filesystem/shell/host access fails before workers spawn.

The dashboard exposes the same library through `GET /api/workflow-definitions`,
`GET /api/workflow-definitions/:id`, `POST /api/workflow-definitions`,
`PUT /api/workflow-definitions/:id`, `DELETE /api/workflow-definitions/:id`, and
`POST /api/workflow-definitions/:id/run`. The React UI lists saved definitions, shows metadata/phases/source,
saves a script run as a project workflow, edits/deletes definitions, and runs a selected definition with JSON
`args`.

### Example (mirroring a Claude workflow)

A fan-out → filter → reduce pass, the imperative shape of a Claude `parallel()` workflow
(see `examples/parallel-reduce.workflow.js`):

```js
// inspect.workflow.js
const files = args.files;            // injected via --args

phase("inspect");
log(`fanning out over ${files.length} file(s)`, { count: files.length });

// one agent per file, all bounded by the shared concurrency limiter;
// agent() resolves to the structured value (or null on failure)
const reports = await parallel(
  files.map((file) => () => agent(`Inspect ${file}; report a one-line summary and a confidence.`))
);

// arbitrary host-side reduction between agent calls
const rank = { high: 0, medium: 1, low: 2 };
const reduced = reports
  .map((r, i) => (r ? { file: files[i], ...r } : null))
  .filter(Boolean)
  .sort((a, b) => (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9));

export default { inspected: files.length, kept: reduced.length, reports: reduced };
```

Drive it via the CLI:

```bash
# CLI — allowed by default (positional <path>, or --path / --source / --args; Ctrl-C aborts)
node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
  --args '{"files":["src/a.js","src/b.js","src/c.js"]}' --concurrency 3

# Free dry run against the mock codex
CODEX_CLI_PATH=test/fixtures/mock-codex.js \
node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
  --args '{"files":["a.js","b.js"]}'
```

A second example, `examples/budget-loop.workflow.js`, shows a `budget`-bounded `loopUntilDry` discovery
surfacing `budget.spent()` / `budget.remaining()`.

### Warm-context workers (opt-in)

By default every worker is a fresh, **ephemeral** `codex exec` subprocess (no session persisted). For a multi-stage
chain where the *same* worker keeps reasoning across turns, the warm executor avoids re-paying the cold-start /
context cost on every stage by keeping a Codex session warm via `codex exec resume <session_id>`:

```js
const handle = await uc.spawnWarmWorker("Read the auth module and summarize it.", {
  ctx,
  executor: "resume", // forces a persisted (non-ephemeral) first turn so a session id exists
});
// handle.sessionId is the resumable session (the first turn's thread_id)
const r2 = await handle.turn("Now list the security risks you noticed.");   // resumes the SAME session
const r3 = await handle.turn("Propose minimal fixes for the top risk.");     // still warm
```

`runPipeline` accepts `warm: true` to give each item its own warm session reused across stages (warm reuse is
**per item**; fan-out *across* items stays parallel with independent sessions):

```js
await uc.runPipeline(items, [
  (item, _i, _idx, _ctx, warm) => warm.start(`Analyze ${item.key}.`),   // stage 0 opens the warm session
  (acc, _i, _idx, _ctx, warm) => warm.turn("Now critique your analysis."), // later stages resume it
], { ctx, warm: true, codex_bin, cwd });
```

The pipeline DAG (`pipeline`) accepts an `executor` (`cold` | `resume` | `fork`) at the top level and per step.

Guarantees and limits:

- **Pure optimization, never a correctness change.** A resume turn that the CLI cannot honor (unknown/expired
  rollout — detected via `no rollout found for thread id`, or any non-zero exit / missing last-message) transparently
  falls back to the identical cold `codex exec`, logging `resume-fallback`. If the first turn yields no session id,
  follow-up turns simply run cold. With nothing opted in (`executor` defaults to `'cold'`, `persistSession` stays
  `false`, `runPipeline.warm` defaults to `false`), the cold fan-out is byte-for-byte unchanged (still `--ephemeral`).
- **Resume turns are sequential.** `codex exec resume` continues one conversation, so warm turns within a single
  worker/item cannot run in parallel — only the cross-item fan-out parallelizes.
- **Schema / sandbox / cwd on a resume turn.** The `resume` subcommand rejects `--output-schema`, `-s/--sandbox`,
  `-C/--cd`, `--add-dir`, and `-p/--profile`. Sandbox/cwd/profile are inherited from the original persisted session;
  the JSON schema is enforced by injecting it into the prompt plus the existing post-hoc validation + schema-retry
  loop. If a stage needs a *different* sandbox/cwd, use cold for that stage.
- **Disk.** A persisted session writes a rollout under `$CODEX_HOME/sessions` instead of `--ephemeral`; this happens
  only when you opt in.
- **`executor: 'fork'` is a documented stub.** `codex fork` is interactive-TUI-only (no `--json`, no
  `codex exec fork`), so true shared-context fan-out is not possible via the non-interactive CLI. `fork` is accepted
  for forward-compat, logs `fork-unsupported`, and runs the cold path.

### Worker transport (opt-in)

The default worker **transport** shells `codex exec --json` and scrapes JSONL events. An opt-in alternative consumes
the versioned **`codex app-server`** JSON-RPC protocol instead, while returning the exact same worker result so usage
accounting, schema validation/retry, worktree isolation, and persistence are unchanged.

| `transport` | Behavior |
| --- | --- |
| `'exec'` *(default)* | Today's `codex exec --json` JSONL path. Also selected by `ULTRACODE_TRANSPORT=exec` or anything unrecognized. |
| `'app-server'` | Spawns `codex app-server`, runs `initialize → initialized → thread/start → turn/start`, accumulates `item/agentMessage/delta` text, and normalizes the `thread/tokenUsage/updated` camelCase breakdown into the engine's usage shape. |
| `'exec-server'` | Reserved. Throws an explicit *not yet implemented* error (the client seam is generic enough to host it later). |

```bash
ULTRACODE_TRANSPORT=app-server node scripts/ultracode-cli.js run --task "..." --progress
node scripts/ultracode-cli.js run --task "..." --transport app-server --progress
```

Notes:

- **Opt-in, with automatic fallback.** Any app-server failure (initialize / unsupported method / protocol error /
  timeout) transparently falls back to the identical exec path and emits a `worker.transport_fallback` event plus a
  narrator log. Pass `transport_strict: true` to surface the error instead of falling back.
- **Lenient framing.** The app-server emits *bare* JSON-RPC objects (no top-level `jsonrpc` field) and proactive
  unsolicited notifications; the client classifies messages by `id`/`result`/`error`/`method`, never by `jsonrpc`.
- **Schema enforcement is transport-agnostic.** The schema is embedded in the turn prompt and enforced by the same
  post-hoc `validateAgainstSchema` + schema-retry loop used by the exec path (no `--output-schema` on the wire).
- **`approvalPolicy` is forced to `never`** so the server never blocks on an approval request.
- **Byte-for-byte default.** `transport` is journaled into `workflow.options` only when non-default, so a plain run's
  record is unchanged. Warm `executor: 'resume'` turns always use the exec path (resume is an exec-only concept).

## Testing & development

The engine and runners have **no npm dependencies**, so the test suite runs on the Node built-in test runner with
no install step. Tests never call real Codex — every spawn is redirected at a **mock** Codex binary, so the whole
suite (and the example workflows below) runs **offline and free**.

```bash
npm test                              # node --test "test/**/*.test.js"
node --test "test/**/*.test.js"       # the same, without the package.json script
node --test test/script-runner.test.js   # run a single test file
```

The suite covers the limiter, schema validation/retry, `spawnWorker`, workflow / resume / pipeline, retry &
cancel, warm-context, the app-server transport, the script runner, and CLI SIGINT handling.

**Running CLI commands and example workflows for free.** Point `CODEX_CLI_PATH` at the mock Codex binary
(`test/fixtures/mock-codex.js`, with `mock-codex-fail.js` for the failure path) and use a throwaway `CODEX_HOME`
so the run never touches your real `~/.codex`:

```bash
CODEX_HOME=$(mktemp -d) CODEX_CLI_PATH=test/fixtures/mock-codex.js \
  node scripts/ultracode-cli.js script examples/parallel-reduce.workflow.js \
  --args '{"files":["a.js","b.js"]}'

CODEX_HOME=$(mktemp -d) CODEX_CLI_PATH=test/fixtures/mock-codex.js \
  node scripts/ultracode-cli.js script examples/budget-loop.workflow.js \
  --budget-tokens 5000 --max-agents 6 --concurrency 2
```

The `examples/` directory ships two ready-to-run scripts: `parallel-reduce.workflow.js` (a fan-out → filter →
reduce pass) and `budget-loop.workflow.js` (a `budget`-bounded `loopUntilDry` that surfaces `budget.spent()` /
`budget.remaining()`). The mock honors `MOCK_CODEX_*` env knobs (e.g. `MOCK_CODEX_RESPONSE`, `MOCK_CODEX_EXIT`,
`MOCK_CODEX_SLEEP_MS`, `MOCK_CODEX_FAIL_TIMES`) — see `test/fixtures/mock-codex.js` and `test/helpers/env.js`.

## State

Runs are journaled to `$CODEX_HOME/ultracode/runs/<id>.json`, rewritten incrementally as events arrive and workers
settle (so CLI `status` reflects progress), and carrying `workers[]`, `events[]`, `aggregate`, and
`aggregate_usage`. Pipeline records also expose `steps[]`; script records are not step-resumable but still journal
their dynamic workers.
New fields are additive; existing readers are unaffected.

## Backward compatibility

The CLI `plan`, `run`, `resume`, and `status` commands keep their original contracts. With only the legacy
fields, `run` executes the identical fixed-role read-only fan-out (now
limiter-scheduled with usage aggregation and progress). All new fields are optional. The only scheduling change:
on small-core machines the ≤8 legacy workers may no longer all run at once — set `concurrency` ≥ `workers` to opt
out.

`pipeline` is fully additive: it is a sibling CLI command that reuses the same engine machinery (context,
limiter, budget, journaled record shape) and does not change any existing CLI command or engine export. The
`workers_spec` and fixed-role paths keep their existing contract, with the shared launch-stagger and auth-refresh
retry protections applied by the context.

The warm-context executor (`executor`, `spawnWarmWorker`, `runPipeline.warm`) is likewise additive and opt-in: it
defaults to the cold ephemeral fan-out and falls back to it on any resume failure, so existing flows are unaffected.

The CLI `script` command is additive: the engine only gains a single lazy `runScript` re-export (call-time
`require`, no require cycle), so existing engine exports are unchanged. Script records (`kind: "script"`) journal
into the same `$CODEX_HOME/ultracode/runs/` directory and
are read by `status` unchanged; `resume` returns a clean no-op message for them because the imperative body is not
step-resumable.
