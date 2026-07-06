# Ultracode quality patterns (in depth)

The patterns the SKLL indexes, explained. **This is a starting set, not a closed menu** — these are building
blocks. When a task doesn't fit one, invent the harness it needs from the same primitives: a *tournament
bracket* (pairwise judge-offs down to a winner), a *self-repair loop* (generate → verify → feed the refutation
back as the next prompt until it survives), *staged escalation* (cheap broad finders first, then escalate only
the survivors to high-effort skeptics). The primitives (`agent`/`parallel`/`pipeline`/`adversarialVerify`/
`loopUntilDry` + a host `while` loop) compose into anything.

**Disposition.** Build the richest useful workflow first, then let it do the work. Prefer composing finder
lanes, critic passes, adversarial verification, and synthesis inside the workflow instead of running a small
panel and finishing the important reasoning in the parent thread. Default to *verifying* your own findings before
you trust or report them — lean toward an adversarial pass. The bar is to *skip* verification (trivial finding,
or already independently verified), not to perform it. A confident-sounding worker is not a verified one.

For copy-pasteable, code-verified versions of everything below, see `cookbook.md`.

## Adversarial verify

Never act on or report a raw finding; make it survive skeptics first. Each finding gets N workers prompted to
**refute** it; it is kept only when refuters are *not* a strict majority (with 3 skeptics, 2+ refutals kill it;
an even split survives). Skeptics default to `refuted=true` when uncertain, so plausible-but-wrong findings
rarely survive.

A finding is *also* dropped if **none** of its skeptics return a valid verdict (all failed/timed out) —
survival requires at least one valid vote. So a thin survivor set is suspect: scan `events[]` for skeptic
failures before trusting the verified set, and raise `skeptics` (or add retries) if worker failures are eating
votes.

- script: `const real = await adversarialVerify(findings, { skeptics: 3 });`
- CLI: a `kind: "verify"` step with `findings_from` / `skeptics` / `lenses` (its `findings_from` must also be
  in `depends_on`; its `output` is the surviving-findings array).

## Perspective-diverse verify

When a finding can fail in more than one way, give each skeptic a distinct **lens** instead of N identical
reviewers — diversity catches failure modes redundancy can't. Pass
`lenses: ["correctness", "security", "reproducibility"]`; each skeptic evaluates from one angle. Never spawn N
identical confirm-the-finding reviewers — that just averages one blind spot.

## Judge panel

For design/decision tasks (which approach, which API shape), fan out N independent attempts from *different
framings* (MVP-first, risk-first, user-first) via a `workers_spec[]`, score them with parallel judge workers,
then synthesize from the winner while grafting the best ideas from the runners-up. Beats one-attempt-iterated
when the solution space is wide.

There is **no judge primitive** (unlike `adversarialVerify`): run the judges as separate blind workers that
neither author the attempts nor see each other's scores, and pick the winner yourself in the parent. That
independence is the whole point of the panel — one judge, or judges that see each other, re-introduce the
single-perspective bias the panel exists to remove.

## Loop-until-dry

For unknown-size discovery (bugs, dead code, edge cases), keep spawning finders until K consecutive rounds
surface nothing new, rather than guessing a fixed count (which always misses the tail).
`loopUntilDry(makePrompt, { dryRounds: 2, maxRounds: 10 })` (script) or a `kind: "loop"` step. The stop is
visible in `events[]` (maxRounds, budget, and cap each log a terminal `reason`; the dry stop shows up as the
per-round `round N dry (X/dryRounds)` lines).

**Convergence is yours to engineer.** For ordinary no-repeat discovery, use
`loopUntilDry(..., { dedupeFindings: true })`: `makePrompt` receives `(round, ctx, state)`, where
`state.seenList` is the running set of finding/source keys, and a round that only repeats seen items counts as
dry. A declarative `kind: "loop"` step can set `dedupe_findings: true` and render `{{seen}}`,
`{{seen_json}}`, and `{{consecutive_dry}}` in its prompt. Hand-roll a `while` loop only when the convergence
rule is more custom than "new findings appeared."

## Multi-modal sweep

Parallel finders each searching a *different way* — by-module, by-symbol/grep, by-test surface,
by-recent-change — each blind to the others. One search angle never surfaces everything. A `workers_spec[]` /
`parallel()` fan-out with a distinct prompt per lane. Pairs naturally with loop-until-dry (one sweep per round).
When unsure whether a lane is worthwhile, include it and let the synthesis stage merge or discard low-yield
results; do not keep that search angle in the parent thread to save agents.

## Completeness critic

End an audit with one worker whose only job is "what's missing — a module not swept, a claim not verified, a
file not read?" Its output is *work, not commentary*: spawn a targeted follow-up pass against exactly the gaps
it names, and loop critic→fill until it comes back empty. Nothing automates this — it's a pattern you build from
`run` / `pipeline`, not a primitive.

Use this as the anti-rationing safety valve: if the parent is tempted to keep investigating after a first pass,
turn that curiosity into a completeness critic and follow-up lanes inside the workflow.

## Loop-until-budget

When the user sets a token target, scale depth to it: gate a discovery loop on the shared `budget`
(`while (budget.total && budget.remaining() > 50_000) { … }`). The `budget.total &&` guard is mandatory, not
stylistic — `budget.remaining()` returns `Infinity` when `--budget-tokens` is unset, so without it the loop
runs straight to the lifetime agent cap. `--budget-tokens` is a shared soft cap across the whole run.

## Two convergence traps to design out

- **Dedup against everything *seen*, not against what *survived*.** In a find→verify loop, dedup new findings
  against the set of everything already *found*. Dedup against the *confirmed* (verified-survivor) set instead
  and every verify-rejected finding reappears next round — the loop never converges. This is the single most
  common reason an "exhaustive" loop never terminates.
- **No silent caps.** Every drop, budget stop, lifetime-cap hit, timeout, and worktree fallback is logged to
  `events[]` (stream with `--progress`, or read it back via `status`). When you deliberately bound coverage
  (top-N, sampling, no retries), say so in your synthesis — silent truncation reads as "covered everything"
  when it didn't. Surface the honest dropped/unverified count.
