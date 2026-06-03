# Ultracode cookbook — runnable skeletons

Copy-pasteable, code-verified starting points. Read the one that matches your task *before* you write a
`--steps` DAG or an imperative script — the captions call out the constraints a model gets wrong. Field/flag details are
in `cli.md`; the why-and-when is in `../SKILL.md` and `quality-patterns.md`.

Everything runs through ONE verb-less command — `node scripts/ultracode-cli.js <input> [flags]`. The input
selects what runs: a `--steps`/`*.json` DAG, `--workers-spec` for a flat panel, a positional `*.js` / `--source` for
imperative JS, a bare task sentence for the fixed-role fan-out, or `@<name>` for a saved workflow.

Every skeleton runs for free against the mock Codex (no paid calls): prefix with
`CODEX_HOME=$(mktemp -d) CODEX_CLI_PATH=test/fixtures/mock-codex.js`.

---

## 1. Flagship review across dimensions, each branch verified the instant its finder resolves

The barrier-free pattern: `sec_v` starts the moment `sec` resolves — while `perf` is still finding. Nothing
waits for everything; only `synth` waits for both verified branches.

```bash
node scripts/ultracode-cli.js --progress --steps '[
  { "id": "sec",
    "prompt": "Find security bugs in the changed files. Cite file:line for each; put them in `findings`." },
  { "id": "perf",
    "prompt": "Find performance bugs in the changed files. Cite file:line for each; put them in `findings`." },

  { "id": "sec_v",  "kind": "verify", "depends_on": ["sec"],  "findings_from": "sec",
    "skeptics": 3, "lenses": ["correctness", "security"],     "prompt": "verify security findings" },
  { "id": "perf_v", "kind": "verify", "depends_on": ["perf"], "findings_from": "perf",
    "skeptics": 3, "lenses": ["correctness", "reproducibility"], "prompt": "verify performance findings" },

  { "id": "synth", "depends_on": ["sec_v", "perf_v"], "schema": null,
    "prompt": "Merge these verified findings into one report.\nSecurity (survived):\n{{steps.sec_v.output}}\nPerformance (survived):\n{{steps.perf_v.output}}" }
]'
```

Three constraints this skeleton encodes — get any wrong and the DAG throws before spawning anything:

- A verify step's **`findings_from` must also be listed in `depends_on`** (here `sec_v` depends on `sec`).
- A verify step **requires a `prompt` but never uses it as worker text** — it runs `adversarialVerify` on the
  `findings_from` output. Pass a short placeholder with **no `{{steps...}}` tokens** (any token must be in
  `depends_on`). The verify step's `output` is the *surviving-findings* array, which `{{steps.sec_v.output}}`
  renders downstream.
- `synth` uses `"schema": null` for a free-text report instead of the structured `WORKER_SCHEMA`.

The same graph runs inside a script via `dag(steps)` — same `depends_on` / `{{steps.<id>.output}}` edges, same
worker/parallel/verify/loop kinds — when you need to read the result in JS or feed it onward. It returns an
`{ [stepId]: output }` map and journals its workers into the script record:

```js
const out = await dag([
  { id: "sec",  prompt: "Find security bugs in the changed files. Cite file:line; put them in `findings`." },
  { id: "perf", prompt: "Find performance bugs in the changed files. Cite file:line; put them in `findings`." },
  { id: "sec_v",  kind: "verify", depends_on: ["sec"],  findings_from: "sec",
    skeptics: 3, lenses: ["correctness", "security"],       prompt: "verify security findings" },
  { id: "perf_v", kind: "verify", depends_on: ["perf"], findings_from: "perf",
    skeptics: 3, lenses: ["correctness", "reproducibility"], prompt: "verify performance findings" },
  { id: "synth", depends_on: ["sec_v", "perf_v"], schema: null,
    prompt: "Merge these verified findings into one report.\nSecurity (survived):\n{{steps.sec_v.output}}\nPerformance (survived):\n{{steps.perf_v.output}}" }
]);
export default { report: out.synth };   // out.synth is the merged free-text report
```

`dag()` is distinct from `pipeline(items, ...stages)` (skeleton 5): `dag` runs a fixed declarative `depends_on`
graph; `pipeline` streams a *list* per-item through ordered stages.

---

## 2. Composed exhaustive-audit harness — find → dedup-vs-seen → diverse-lens verify → loop-until-dry, under budget

The canonical "be exhaustive" loop. Hand-rolled `while` (not `loopUntilDry`) because it must inject the running
`seen` set into each round so a re-find counts as dry. Save as `exhaustive-audit.workflow.js`, run with
`node scripts/ultracode-cli.js exhaustive-audit.workflow.js --budget-tokens 800000 --concurrency 6 --progress`.

```js
const seen = new Set();   // dedup vs SEEN (everything found), NOT vs confirmed — else rejected findings reappear and it never goes dry
const confirmed = [];
const LANES = ["by-module", "by-recent-change", "by-test surface", "by-symbol/grep"];
let dry = 0, round = 0;

phase("audit");
while (dry < 2 && round < 10) {
  if (budget.total && budget.remaining() < 50_000) { log("stopping: budget nearly spent", { remaining: budget.remaining() }); break; }
  round += 1;
  const seenList = seen.size ? [...seen].join("\n") : "(none yet)";

  // multi-modal sweep: each lane searches a different way, blind to the others
  const batches = await parallel(LANES.map((lane) => () =>
    agent(`Audit this codebase via the "${lane}" lens. Find REAL bugs, cite file:line. ` +
          `Return ONLY findings NOT already in this list:\n${seenList}`)
  ));

  // agent() returns the WORKER_SCHEMA value (so .findings is a string[]) or null on failure
  const fresh = batches.filter(Boolean).flatMap((b) => b.findings || []).filter((f) => !seen.has(f));
  if (fresh.length === 0) { dry += 1; log(`round ${round} dry (${dry}/2)`); continue; }
  dry = 0;
  fresh.forEach((f) => seen.add(f));

  // adversarial, perspective-diverse verify before anything is trusted; returns the survivors
  const real = await adversarialVerify(fresh, { skeptics: 3, lenses: ["correctness", "security", "reproducibility"] });
  confirmed.push(...real);
  log(`round ${round}: ${fresh.length} fresh, ${real.length} survived`, { fresh: fresh.length, survived: real.length });
}

export default {
  confirmed,
  swept_rounds: round,
  dropped: seen.size - confirmed.length,   // honest: fresh findings that did NOT survive verification (no silent caps)
};
```

Why hand-rolled, not `loopUntilDry`: the built-in passes `makePrompt` only `(round, ctx)` and hands you results
only when the whole call returns, so it can't carry `seen` between rounds. The `while` loop is the honest way to
show convergence. Dedup is against `seen`, never `confirmed` — that's what makes it terminate.

---

## 3. When `loopUntilDry` fits — and when it can't

Use the built-in when each round is independently productive and re-finds are fine (you dedup in post):

```js
// loopUntilDry returns one WORKER_SCHEMA value per PRODUCTIVE round; it feeds nothing forward.
const batches = await loopUntilDry(
  (round) => `Discovery round ${round + 1}. Find issues in src/. Return them in \`findings\`.`,
  { dryRounds: 2, maxRounds: 8 }
);
const all = [...new Set(batches.flatMap((b) => b.findings || []))];   // dedup happens HERE, after the fact
```

It **cannot** avoid re-finding across rounds: `makePrompt` never sees prior findings, and a `kind: "loop"` step
exposes only `{{round}}`. If round 2 must skip what round 1 found, the built-in won't do it — reach for the
hand-rolled `while` loop in skeleton 2 (a closure-held `seen` set injected into each prompt) instead.

---

## 4. A custom per-worker schema tuned to the finding shape you want

Don't default to the generic `WORKER_SCHEMA` string-array `findings`. Design the schema for the exact shape
downstream stages key on:

```bash
node scripts/ultracode-cli.js --progress --workers-spec '[
  {
    "label": "sec-finder",
    "prompt": "Find security bugs in src/. Cite the exact file and line for each.",
    "schema": {
      "type": "object", "additionalProperties": false, "required": ["findings"],
      "properties": {
        "findings": {
          "type": "array",
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["file", "line", "severity", "claim"],
            "properties": {
              "file":     { "type": "string" },
              "line":     { "type": "integer" },
              "severity": { "type": "string", "enum": ["low", "med", "high"] },
              "claim":    { "type": "string" }
            }
          }
        }
      }
    }
  }
]'
```

The engine validates at the tool layer and retries once on mismatch (`schemaRetries` defaults to 1 when a
schema is set). `additionalProperties: false` makes the model drop stray keys. A typed `findings` array like
this is exactly what a downstream `verify` step votes on (`findings_path` defaults to `findings`) and what your
dedup compares — far more useful than an untyped string blob.

The same flat panel runs inside a script via `fanout(specs)` — one bounded barrier over an array of
`{prompt, label?, schema?, sandbox?, model?, ...}` specs, returning an array of worker values (`null` per
failure), exactly like `parallel()`:

```js
const panel = await fanout([
  { label: "sec-finder", schema: SEC_SCHEMA, prompt: "Find security bugs in src/. Cite the exact file and line for each." },
  { label: "perf-finder",                    prompt: "Find performance bugs in src/. Cite the exact file and line for each." }
]);
const findings = panel.filter(Boolean).flatMap((r) => r.findings || []);
```

Passing a single task *string* instead — `fanout("review the auth refactor", { workers: 5 })` — expands the
built-in 1-8 fixed reviewer roles, the in-script twin of `node scripts/ultracode-cli.js "review the auth
refactor" --workers 5`.

---

## 5. Smell test — a barrier you don't need

The most common over-orchestration: two `parallel()` barriers with a per-item transform between them.

```js
// SMELL — two barriers around a per-item transform
const found   = await parallel(files.map((f) => () => agent(`find issues in ${f}`)));            // barrier #1
const tagged  = found.filter(Boolean).map((r, i) => ({ file: files[i], ...r }));                 // per-item transform
const checked = await parallel(tagged.map((t) => () => agent(`verify ${t.file}: ${t.summary}`))); // barrier #2
// The transform needs only each item's OWN output — nothing cross-item. The barriers just idle the fast
// finders until the slowest finishes, twice. Wall-clock = slowest_find + slowest_verify, not per-item.

// FIX — one barrier-free streaming chain; each file flows find → tag → verify on its own clock
const checked = await pipeline(
  files,
  (file)         => agent(`find issues in ${file}`),
  (found, file)  => (found ? { file, ...found } : null),                          // transform AS a stage
  (tagged)       => (tagged ? agent(`verify ${tagged.file}: ${tagged.summary}`) : null)
);
```

Keep a barrier **only** when a stage must see *all* items at once: dedup/merge across the full set, or a
zero-count early-exit ("0 findings → skip verification entirely"). A per-item filter/transform is never a reason
for one — make it a middle stage.
