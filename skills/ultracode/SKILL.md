---
name: ultracode
description: Use when the user asks for Ultracode, deep parallel code investigation, multiple Codex worker passes, fan-out/fan-in analysis, subprocess-backed code review, multi-stage pipelines, budgeted/concurrency-capped worker runs, an exhaustive/sign-off audit, adversarial verification or a judge panel of worker agents, loop-until-dry discovery, multi-modal sweeps, or a Claude-style under-the-surface workflow in Codex.
---

# Ultracode

Ultracode gives Codex an orchestration engine that mirrors Claude Code's Workflow tool — `spawnWorker` (agent),
`runParallel` (fan out, wait for all), `runPipeline` (stream each item stage-to-stage), schema-validated
structured output, a shared concurrency cap, token-budget gating, progress events, journaled resume, and
quality helpers — all driven by real `codex exec` subprocesses. Three surfaces reach it: a fixed-role /
`workers_spec` fan-out (`run`), a declarative DAG (`pipeline`), and an imperative Workflow-script runner
(`script`).

This file is the **decision layer** — read it to decide whether, at what scale, and with which surface to use
Ultracode. Pull depth from `references/` only when you're actually building:

| When you're… | Read |
| --- | --- |
| choosing a quality/verification/discovery pattern, or inventing one | `references/quality-patterns.md` |
| about to write a `pipeline --steps` or a `script` — get the shape right first | `references/cookbook.md` |
| needing an exact flag, step field, primitive signature, or the `script` API | `references/cli.md` |

## When to reach for Ultracode

Reach for it when one of three things is true — and skip it otherwise:

- **Be comprehensive.** The task means sweeping many files, modules, or call sites and you want them covered in
  parallel: broad audits, "find every X", understanding a whole subsystem.
- **Be confident.** A conclusion is only worth committing to after independent perspectives and an adversarial
  check: sign-off reviews, risky refactors, "is this actually a bug or a false alarm".
- **Take on scale one pass can't hold.** Migrations, repo-wide sweeps, investigations whose evidence won't fit a
  single thread's attention.

If the task is small, local, or you already know the answer, work directly — a `codex exec` fan-out has real
overhead (subprocess startup, no shared memory, synthesis cost). Ultracode earns it through breadth or
independent verification, not raw speed.

**Scale to the request.** Match worker count and verification depth to what was asked:

- "Take a quick look" → 2-3 finders, single-vote verify (or none).
- "Review this change" → a fixed-role `run` (3-5 workers) + an adversarial pass over the findings.
- "Thoroughly audit / be exhaustive / sign off on this" → a large finder pool or a loop-until-dry, a 3-5 vote
  adversarial pass with distinct lenses, then a synthesis stage.

Don't run a six-worker audit for a one-file question, and don't run three finders when asked to be exhaustive.

## Operating rules

- **Verify before you trust.** Default to an adversarial pass over your own findings before you act on or
  report them; skip verification only when the finding is trivial or already independently verified. The bar is
  to skip it, not to perform it.
- Keep workers **read-only** (`sandbox: read-only`, the default) unless the user explicitly wants writable child
  runs. For parallel writers, prefer `isolation: "worktree"` so their diffs don't collide.
- Treat worker failures as **real failures**. A failed, timed-out, or refuted worker resolves to `null` / a
  `{status:"failed"}` record — filter it out; never substitute guessed output for it.
- **Synthesize in the parent thread.** Read every result (including failures and low-confidence notes), merge
  duplicates, prefer concrete file/line evidence over generic advice, make the actual edits yourself so the
  meaningful implementation stays visible in the Codex app/TUI, then run normal verification after applying.

## Pick a surface

Three surfaces reach the same engine, in increasing expressiveness. Default to the barrier-free ones.

- **`run`** — a flat fan-out: every worker runs at once and you get all results back together (one barrier at
  the end). Use for a single bounded pass with no data flow between workers — a fixed-role review, or a
  `workers_spec[]` panel of arbitrary prompts/schemas.
- **`pipeline`** (declarative DAG) — **barrier-free**: each step starts the instant *its own* `depends_on`
  resolve, so a finding from one branch can already be verifying while another branch is still finding. The
  default for multi-stage work. Cross-stage data flows by rendering `{{steps.<id>.output}}` tokens.
- **`script`** — imperative JavaScript with the primitives bound into scope (`agent`, `parallel`, `pipeline`,
  `loopUntilDry`, `adversarialVerify`, `budget`, …). The only surface that combines agents with arbitrary
  host-side control flow — loops, `map`/`filter`/`sort`, reductions, budget-driven branching. Reach for it when
  the orchestration logic itself is dynamic.

**Barrier vs barrier-free.** Prefer barrier-free staging (`pipeline` DAG, or the script `pipeline()`), where
each item streams through every stage independently. *Why it's the default:* a barrier-free pipeline's
wall-clock is the slowest single-item chain (find→verify for one item), **not** the sum of stages and not
"slowest finder, then slowest verifier." A barrier makes every lane wait for the slowest before any advances —
if 5 finders run and the slowest takes 3× the fastest, a barrier idles the 4 fast lanes for two-thirds of their
time while item A could already be verifying. You pay that idle only to gain a cross-item view.

So a barrier — `run`, or a script `parallel()` whose results you collect before the next stage — is justified
**only** when a stage genuinely needs *all* prior-stage results at once:

- dedup or merge across the full result set before expensive downstream work,
- early-exit when the total count is zero ("0 findings → skip verification entirely"),
- a stage whose prompt compares one finding against all the others.

It is NOT justified by "I need to flatten/filter the results first" — a per-item filter/transform needs only
that item's own prior output, so it stays a barrier-free stage. (The `parallel → transform → parallel` mistake,
and its one-pipeline rewrite, is worked in `references/cookbook.md` §5.) When in doubt, stay barrier-free.

## Write worker prompts that return evidence

Workers are separate `codex exec` subprocesses that share no memory with you or each other. Two consequences
shape every prompt:

- **A worker's output IS its return value, not a message to a human.** Tell it to return raw data that
  satisfies the schema. By default a worker returns the `WORKER_SCHEMA` shape (`summary`, `findings[]`,
  `recommended_actions[]`, `risks[]`, `verification[]`, `confidence`); pass a custom `schema` to force a shape
  tuned to your task (worked example: `references/cookbook.md` §4), or `schema: null` for raw text.
- **Cross-stage context must be passed explicitly** — via `{{steps.<id>.output}}` tokens in a `pipeline`, or via
  the prompt string you build in a `script`. A worker knows only what its prompt contains.

Demand concrete evidence — "cite `file:line`", "name the failing command", "quote the offending code" — over
generic recommendations. For verification workers, prompt each skeptic to **refute, not confirm**: "Try hard to
refute this finding; if you cannot clearly confirm it is real and correct, set `refuted=true`."

## Quality patterns

These are building blocks, **not a closed menu** — invent novel harnesses (tournament bracket, self-repair
loop, staged escalation) when a task doesn't fit. Depth and caveats: `references/quality-patterns.md`. Runnable,
code-verified versions: `references/cookbook.md`.

- **Adversarial verify** — a finding must survive N skeptics prompted to refute it (majority refutes kill it)
  before you act or report. The default verification pass. → cookbook §1–2
- **Perspective-diverse verify** — give each skeptic a distinct `lens` (correctness/security/reproducibility),
  not N identical reviewers.
- **Judge panel** — N attempts from different framings → blind parallel judges → synthesize the winner. No
  judge primitive; you pick the winner in the parent.
- **Loop-until-dry** — keep spawning finders until K consecutive dry rounds. *You* own cross-round dedup
  (`loopUntilDry` feeds nothing forward). → cookbook §2–3
- **Multi-modal sweep** — parallel finders, each searching a different way (by-module/symbol/test/recent), blind
  to each other.
- **Completeness critic** — a final "what's missing?" worker whose output becomes the next round of work.
- **Loop-until-budget** — gate depth on `budget.remaining()`; the `budget.total &&` guard is mandatory (it's
  `Infinity` when unbudgeted).

**Two traps:** dedup against everything *seen*, not against what *survived* (or a find→verify loop never
converges); and **no silent caps** — log/surface every drop, cap, and truncation (`--progress` / `status`).
