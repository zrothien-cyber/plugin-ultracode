// ultracode example: stateful research loop - gather until dry, then synthesize.
//
// This template is for open-ended research where you do not know up front how
// many passes are needed. It uses loopUntilDry's stateful dedupe mode so each
// round sees the running source/finding memory and repeat-only rounds count as
// dry.
//
// Run against the mock codex (no paid calls):
//   CODEX_HOME=$(mktemp -d) MOCK_CODEX_COUNTER=$(mktemp) \
//   CODEX_CLI_PATH=test/fixtures/mock-codex.js \
//   MOCK_CODEX_RESPONSE='{"summary":"mock","findings":["claim A - https://example.com/a"],"recommended_actions":[],"risks":[],"verification":[],"confidence":"high"}' \
//   MOCK_CODEX_ALT_RESPONSE='{"summary":"mock repeat","findings":["claim A - https://example.com/a"],"recommended_actions":[],"risks":[],"verification":[],"confidence":"high"}' \
//   node scripts/ultracode-cli.js examples/research-loop.workflow.js \
//     --args '{"topic":"How are autonomous research loops used today?","max_rounds":3,"dry_rounds":1}'
//
// Against the real codex: remove the mock env vars. Workers should cite URLs
// for web mode or file:line references for code mode.

const topic =
  (args && typeof args.topic === "string" && args.topic.trim()) ||
  "How are autonomous research loops being used today?";
const mode = args && args.mode === "code" ? "code" : "web";
const maxRounds = Math.max(1, Math.min(12, Number(args && args.max_rounds) || 6));
const dryRounds = Math.max(1, Math.min(4, Number(args && args.dry_rounds) || 2));

const sourceInstruction =
  mode === "code"
    ? "Read this repository. Every finding must cite a file:line reference."
    : "Search the web and read primary sources. Every finding must cite a URL.";

phase("research-until-dry");
const batches = await loopUntilDry(
  (round, _ctx, state) =>
    `Research round ${round + 1} for this topic: "${topic}".\n` +
    `${sourceInstruction}\n\n` +
    `Already seen finding/source keys:\n` +
    `${state.seenList.length ? state.seenList.map((item) => `- ${item}`).join("\n") : "(none)"}\n\n` +
    `Return ONLY genuinely new, evidence-backed findings in \`findings\`. ` +
    `Format each finding as "claim - source". If you cannot find anything new, return an empty findings array.`,
  {
    maxRounds,
    dryRounds,
    dedupeFindings: true
  }
);

const uniqueFindings = [...new Set(batches.flatMap((batch) => batch.findings || []))];

phase("synthesize");
const report = await agent(
  `Write a concise research brief answering: "${topic}".\n` +
    `Use ONLY these cited findings and preserve the citations:\n` +
    (uniqueFindings.length
      ? uniqueFindings.map((finding, index) => `${index + 1}. ${finding}`).join("\n")
      : "(no cited findings were discovered)"),
  { schema: null }
);

export default {
  topic,
  mode,
  rounds_with_new_findings: batches.length,
  findings: uniqueFindings,
  report
};
