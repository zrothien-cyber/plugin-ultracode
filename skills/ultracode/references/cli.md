# Ultracode CLI & API reference

Lookup material — flags, step fields, primitive signatures. The *decision* guidance (when to reach for
Ultracode, which surface, which pattern) lives in `../SKILL.md`; runnable end-to-end examples live in
`cookbook.md`. Read this when you already know what you're building and need the exact flag or field.

Run commands as `node scripts/ultracode-cli.js <command> [--flags]` from the plugin checkout, or use the
absolute `scripts/ultracode-cli.js` path inside the installed plugin cache. Add `--progress` to stream events
to stderr. `--workers-spec`, `--steps`, `--force-steps`, and `--args` take JSON; numeric flags are coerced;
engine options map to kebab-case flags (`--budget-tokens`, `--max-retries`, `--reasoning-effort`,
`--transport`, `--executor`, …).

## Commands

- `plan`: produce the worker plan without running subprocesses (the dry-run of `run`).
- `run`: fan out Codex subprocess workers in parallel and return structured findings (one terminal barrier).
- `pipeline`: run a declarative `steps[]` DAG of Codex stages — barrier-free scheduling.
- `resume`: resume a persisted workflow — completed steps are reused from the journal; only missing/failed/
  forced steps re-run.
- `status`: inspect persisted workflow state (journaled, so it reflects mid-flight progress). A deliberately
  cancelled run (first Ctrl-C) is recorded with status `cancelled`, distinct from `failed`/`partial`/`completed`.
- `script`: run an imperative Workflow script (the Codex analogue of Claude Code's in-process Workflow tool).
- `workflow`: list, show, run, or save Claude-style saved workflow definitions from `.claude/workflows`.

`run`, `pipeline`, `resume`, and `script` launch the local React dashboard by default. The dashboard URL is
stored on `record.ui.url` and emitted as a `ui.ready` event. Disable it with `--no-ui` or `ULTRACODE_UI=0`.
Optional UI flags: `--ui true|false`, `--ui-host <host>`, and `--ui-port <port>` (default host `127.0.0.1`,
port `0`). The dashboard serves checked-in assets from the plugin cache and reads the same journal files as
`status`; it does not require `npm install`.

## `run` arguments

Default fixed-role fan-out:

- `task`: natural-language objective (required unless `workers_spec` is given).
- `cwd`: repository or workspace path. Use the current working directory when possible.
- `workers`: 1-8. Use 3 for normal deep work, 5-6 for broad audits.
- `model`: optional Codex model for child workers.
- `reasoning_effort`: optional `low`, `medium`, `high`, or `xhigh`.
- `sandbox`: default `read-only`. Use `workspace-write` or `danger-full-access` only when the user explicitly
  wants child workers to modify files.
- `timeout_ms`: per-worker timeout (default 1,200,000 = 20 min; min 1000). The kill ladder is SIGTERM then
  SIGKILL after 5s.
- `codex_bin`: optional Codex binary path (else `CODEX_CLI_PATH`, else app-bundle candidates / bare `codex`).
- `codex_home`: optional `CODEX_HOME` for child workers (else inherited; defaults to `~/.codex`).

Orchestration controls (all optional, all backward-compatible):

- `concurrency`: max simultaneous Codex subprocesses. Defaults to `min(16, cores-2)`.
- `launch_stagger_ms`: tiny per-workflow delay between simultaneous subprocess starts. Default `25`, override with
  `ULTRACODE_LAUNCH_STAGGER_MS`, or set `0` to disable.
- `budget_tokens`: best-effort total token budget — a pre-spawn gate checked when a worker is admitted, with
  usage accounted after each worker completes. New workers are skipped (and the cap logged) once exceeded, but
  with concurrency N up to N in-flight workers may still finish past the budget. A soft cap, not a hard
  per-token kill switch. Default `null` (unbounded); shared across all spawns in the run.
- `max_agents`: lifetime cap on spawned workers for the run (default 1000).

Transient-retry knobs (retries fire **only** on classified transient errors — HTTP 429/5xx, rate-limit,
network errno, or transient auth-refresh races — never on login-required/bad-credential/bad-flag/schema/timeout/unknown failures):

- `max_retries`: per-worker transient retries. Default `0` (byte-identical to the pre-retry engine).
- `base_delay_ms`: base backoff delay. Default `500`.
- `max_delay_ms`: backoff cap. Default `30000`.
- `retry_jitter`: full-jitter in `[0, min(max, base*2^attempt)]`. Default `true`.
- Transient auth-refresh races get one implicit restart even when `max_retries` is `0`.

Schema-mismatch retries are a separate counter (default `1` when a schema is set, else `0`) and never consume
the transient-retry budget.

Transport (opt-in; also settable via `ULTRACODE_TRANSPORT`):

- `transport`: `exec` (default — shells `codex exec --json`), `app-server` (versioned JSON-RPC, **auto-falls
  back to exec** on any failure), or `exec-server` (reserved — throws not-yet-implemented). Unknown values
  coerce to `exec`.
- `transport_strict`: when `true`, an `app-server` failure errors instead of falling back. Default `false`.

Arbitrary per-worker fan-out (the `agent()` parity path) — `workers_spec`: an array of worker specs that
replaces the fixed roles. Each spec:

- `prompt` (required): the worker's full instructions.
- `label`: display label used in progress and aggregation.
- `schema`: a JSON Schema object for this worker's output. Omit for the default `WORKER_SCHEMA`; pass `null`
  for raw free-text. (A worked custom schema is in `cookbook.md`.)
- `sandbox`, `model`, `reasoning_effort`, `phase`, `timeout_ms`, `cwd`: per-worker overrides.
- `isolation: "worktree"`: run a writable worker in an isolated git worktree (its diff is collected back).

## `pipeline` arguments

A declarative directed-acyclic graph of stages. Scheduling is **barrier-free** (see _Pick a surface_ in
`../SKILL.md` for why that's the default); the whole DAG is validated **before any spawn** — duplicate id,
unknown/self dependency, and cycles all throw, with zero side effects.

Top-level args mirror `run`'s orchestration controls — `cwd`, `sandbox`, `model`, `reasoning_effort`,
`timeout_ms`, `codex_bin`, `codex_home`, `concurrency`, `launch_stagger_ms`, `budget_tokens`, `max_agents`, the retry knobs,
`transport`, `transport_strict`, and an optional descriptive `task` — plus:

- `steps` (required): array of step objects (at least one).
- `executor`: default warm executor for every step — `cold` (default), `resume`, or `fork` (degrades to cold).

Each step:

- `id` (required): unique, `[A-Za-z0-9_-]+`; referenced by other steps' `depends_on` and `{{steps.<id>...}}`.
- `kind`: `worker` (default), `parallel`, `verify`, or `loop`.
- `prompt` (**required for every kind**): the prompt template. Cross-stage data flows by rendering tokens
  (resolved just before spawn; an unresolved token throws rather than emitting a blank): `{{steps.<id>.output}}`,
  `{{steps.<id>.output.<path>}}` (drill-in), `{{steps.<id>.summary}}`, `{{round}}` (inside a `loop`), and
  `{{item.<key>}}` (inside a `parallel`). **A step may only render tokens for ids in its own `depends_on`** (the
  compiler throws otherwise). Note `verify`/`loop` still *require* a `prompt` even though they don't use it as
  worker text (see below) — pass a token-free placeholder.
- `schema`: per-step JSON Schema (omit for `WORKER_SCHEMA`; `null` for raw text).
- `depends_on`: array of upstream step ids.
- `label`, `phase`, `sandbox`, `model`, `reasoning_effort`, `timeout_ms`, `cwd`, `isolation: "worktree"`,
  `executor`: per-step overrides.
- `verify`-only (`kind: "verify"`, wraps `adversarialVerify`): `findings_from` (upstream step id whose findings
  to vote on — **must also appear in `depends_on`** or the compiler throws), `findings_path` (dot-path into that
  output, default `findings`), `skeptics` (default 3), `lenses`, `context`. The step's own `prompt` is not used
  as worker text; its `output` is the surviving-findings array.
- `loop`-only (`kind: "loop"`, wraps `loopUntilDry`): `dry_rounds` (default 2), `max_rounds` (default 10);
  exposes `{{round}}` only — a loop step **cannot** see prior rounds' findings (for cross-round dedup, hand-roll
  a script `while` loop — see `cookbook.md`).
- `parallel`-only (`kind: "parallel"`): `fanout` (int, default 1) **or** `items` (array, each exposed via
  `{{item.<key>}}`).

Pipeline records include a top-level `steps[]` array and keep `workers[]` as the same step records for existing
`status` and `resume` readers. Completed worker/step records expose both `result` and `value` aliases. Pipeline
resume is **partial**: re-running an upstream step does not re-render or cascade to downstream dependents.

## `resume` / `status` arguments

- `resume`: `workflow_id` (or `state_path`) — the run to resume; `force_steps` — array of step ids / role ids /
  indices to re-run even if already completed.
- `status`: `workflow_id` or `state_path` (omit for the latest run).

## Engine primitives (scripted orchestration)

`scripts/ultracode-engine.js` exports composable primitives for callers driving Ultracode from Node. All share
one `ctx` (concurrency limiter, usage accumulator, `budget`, lifetime cap, progress sink) from
`createContext(opts)`. Inside a Workflow `script` these are pre-bound (ctx auto-injected) — see below.

- `spawnWorker(prompt, opts)` → one `codex exec` worker; returns `{status, value, result, usage, ...}`. With
  `opts.schema` it validates and retries once on mismatch; with `schema: null` it returns raw text. Never throws.
- `spawnWarmWorker(prompt, opts)` → like `spawnWorker` but returns a handle whose `.turn(prompt)` resumes the
  **same** warm Codex session (`executor: "resume"`); any resume the CLI cannot honor falls back to cold exec.
- `runParallel(thunks, {ctx})` → barrier gather; a throwing thunk degrades to `null` (logged).
- `runPipeline(items, stages, {ctx})` → barrier-free multi-stage streaming; each item flows through all stages
  independently; a throwing stage drops that item to `null`.
- `loopUntilDry(makePrompt, {schema, dryRounds, maxRounds, ctx})` → keep spawning finders until K dry rounds /
  budget / lifetime cap. `makePrompt` receives only `(round, ctx)` — it sees no prior-round findings.
- `adversarialVerify(findings, {skeptics, lenses, ctx})` → keep only findings that survive a majority refute
  vote from N skeptic workers (optionally with distinct lenses).
- `validateAgainstSchema`, `createLimiter`, `sumUsageFromWorkers`, `log` are also exported.

## Workflow scripts (`script`) — API surface

Plain async JavaScript with the engine primitives pre-bound into scope, so a multi-agent workflow reads like
ordinary code with `await`, `map`/`filter`/`sort`, and arbitrary host-side reductions between agent calls. Drive
it via `node scripts/ultracode-cli.js script <path> --args '<json>'` (positional path, or `--path` / `--source`).

Bound scope (ctx is auto-injected — never pass it):

- `agent(prompt, opts?)` → the worker `value` on completion, else `null` (failure already logged). The
  ergonomic happy-path primitive.
- `spawnWorker(prompt, opts?)` → the full `{status, value, result, usage, ...}` record (advanced).
- `parallel(thunks)` → barrier gather; throwing thunk → `null`.
- `pipeline(items, ...stages)` → **variadic**; each stage receives `(prev, item, index, ctx)`; barrier-free.
- `loopUntilDry(makePrompt, opts?)`, `adversarialVerify(findings, opts?)` → as above; both inherit the current
  `phase()` by default inside scripts.
- `log(message, data?)`, `phase(title)`, `workflow(pathOrSource, args?)` (one-level nested run).
- `context` (`{ args, cwd, workflow, phase, log, budget }`) and `orchestrator` (namespace alias for the
  primitives) for Claude-compatible saved workflows.
- `budget` (`{ total, spent(), remaining() }`), `args`, `ctx`, `WORKER_SCHEMA`, `VERDICT_SCHEMA`.

Top-level `await` and a top-level `return` (or top-level `export default <expr>`) become `record.result`.
The journaled `kind: "script"` record is readable by `status`, updates while the script is running, and includes
the dynamic worker records spawned by `agent`, `spawnWorker`, `loopUntilDry`, and `adversarialVerify`. See
`examples/parallel-reduce.workflow.js` and
`examples/budget-loop.workflow.js`, and `cookbook.md` for the composed patterns.

Script records also include a source snapshot:

- `script_path`: the saved source copy under `$CODEX_HOME/ultracode/scripts/`.
- `source_path`: the original path when run from a file.
- `source_hash`: SHA-256 of the script source.
- `meta`: parsed Claude-style `export const meta = { name, description, phases }` when present.
- `definition_ref`: saved-workflow identity when run through `workflow run`.

`resume_from_run_id` / `resumeFromRunId` enables explicit cached-call reuse for scripts. Completed prior
`agent()` / `spawnWorker()` calls are reused only when the deterministic prompt+options cache key matches; changed
calls spawn live workers. This is narrower than full arbitrary-JS step resume.

## Saved workflow definitions (`workflow`)

Saved definitions are JavaScript workflows discovered in this order:

- `<cwd>/.claude/workflows/*.js`
- `~/.claude/workflows/*.js`
- `$CODEX_HOME/ultracode/workflows/*.js`

Project definitions win when names collide.

```bash
node scripts/ultracode-cli.js workflow list
node scripts/ultracode-cli.js workflow show deep-research
node scripts/ultracode-cli.js workflow run deep-research --args '{"topic":"Codex"}'
node scripts/ultracode-cli.js workflow save deep-research --workflow-id ultra-...
node scripts/ultracode-cli.js workflow save deep-research --source 'export const meta = { name: "Deep Research" }; return {};'
node scripts/ultracode-cli.js workflow update deep-research --source-path .claude/workflows/deep-research.js
node scripts/ultracode-cli.js workflow delete deep-research
```

`workflow run` turns on strict Claude-compat diagnostics and adapters before execution. Allowed workflow
primitive imports are rewritten to the bound runtime, `export async function run(context)` is invoked
automatically, and direct workflow-side filesystem/shell/host access fails explicitly before workers spawn.
The dashboard server also exposes definition list/show/save/update/delete/run endpoints, and the React UI shows
the workflow library with source editing and JSON-args run support.

## Warm-context executor & transport (opt-in)

`--executor cold|resume|fork` (top-level or per step) keeps a Codex session warm across turns; `cold` is the
default and `fork` degrades to cold (`codex fork` is TUI-only). `--transport exec|app-server` selects the worker
transport; `app-server` auto-falls-back to `exec` on any failure unless `--transport-strict`. Both are pure
optimizations that never change a run's correctness. Full semantics and fallback guarantees: _Warm-context
workers_ and _Worker transport_ in `README.md`.

## Cancellation

For `run`, `pipeline`, `resume`, and `script`, the first Ctrl-C aborts the in-flight run and prints the
partially-completed persisted workflow (status `cancelled`, resumable from its journal); a second Ctrl-C
hard-exits 130. Opt out with `--no-cancel-on-sigint` or `ULTRACODE_NO_SIGINT`. (`plan` and `status` never
intercept Ctrl-C.)

## Limits

Ultracode subprocesses do not render as native Codex app/TUI sub-agents — the CLI result is the visible bridge
back into the parent thread. Token-budget gating depends on Codex reporting `turn.completed.usage`; worktree
isolation requires a git repository. See `README.md` for the full Claude-Workflow parity matrix.
