"use strict";

// Fast, spawn-free unit tests for the CLI's pure dispatch/arg helpers and the
// engine export contract. Requiring the CLI is safe (it guards main() behind
// `require.main === module`, so importing never runs the live auto-update).

const test = require("node:test");
const assert = require("node:assert");

const cli = require("../scripts/ultracode-cli.js");
const engine = require("../scripts/ultracode-engine.js");

test("a leading zero-arg switch flag does not swallow the input positional", () => {
  for (const flag of ["--progress", "--no-auto-update", "--no-ui", "--no-cancel-on-sigint"]) {
    const { command, options } = cli.dispatchParse([flag, "review the code"]);
    assert.strictEqual(command, "exec");
    assert.strictEqual(options._positional, "review the code", `${flag} must not eat the positional`);
    assert.strictEqual(options[flag.slice(2).replace(/-/g, "_")], true, `${flag} should be a boolean true`);
  }
});

test("a value-taking flag (--ui) still consumes its value", () => {
  const { options } = cli.dispatchParse(["a task", "--ui", "false"]);
  assert.strictEqual(options.ui, "false");
  assert.strictEqual(options._positional, "a task");
});

test("dispatchParse routes lifecycle verbs vs the unified exec command", () => {
  assert.strictEqual(cli.dispatchParse(["status"]).command, "status");
  assert.strictEqual(cli.dispatchParse(["resume", "--workflow-id", "x"]).command, "resume");
  assert.strictEqual(cli.dispatchParse(["workflow", "list"]).command, "workflow");
  assert.strictEqual(cli.dispatchParse(["review this change"]).command, "exec");
  // Removed verbs are no longer reserved -> they fall through to the exec input.
  for (const removed of ["run", "pipeline", "script", "plan", "update"]) {
    assert.strictEqual(cli.dispatchParse([removed]).command, "exec", `${removed} is no longer a verb`);
  }
});

test("autoUpdateDisabled honors the opt-out flag and env vars", () => {
  const savedNo = process.env.ULTRACODE_NO_AUTO_UPDATE;
  const savedLegacy = process.env.ULTRACODE_AUTO_UPDATE;
  try {
    delete process.env.ULTRACODE_NO_AUTO_UPDATE;
    delete process.env.ULTRACODE_AUTO_UPDATE;
    assert.strictEqual(cli.autoUpdateDisabled({}), false, "on by default");
    assert.strictEqual(cli.autoUpdateDisabled({ no_auto_update: true }), true, "--no-auto-update opts out");
    process.env.ULTRACODE_NO_AUTO_UPDATE = "1";
    assert.strictEqual(cli.autoUpdateDisabled({}), true, "ULTRACODE_NO_AUTO_UPDATE=1 opts out");
    process.env.ULTRACODE_NO_AUTO_UPDATE = "0";
    process.env.ULTRACODE_AUTO_UPDATE = "0";
    assert.strictEqual(cli.autoUpdateDisabled({}), true, "legacy ULTRACODE_AUTO_UPDATE=0 opts out");
  } finally {
    if (savedNo === undefined) delete process.env.ULTRACODE_NO_AUTO_UPDATE;
    else process.env.ULTRACODE_NO_AUTO_UPDATE = savedNo;
    if (savedLegacy === undefined) delete process.env.ULTRACODE_AUTO_UPDATE;
    else process.env.ULTRACODE_AUTO_UPDATE = savedLegacy;
  }
});

test("engine keeps its documented entry points exported (incl. the intentionally-kept planWorkflow)", () => {
  for (const name of [
    "runWorkflow",
    "runPipelineSpec",
    "resumeWorkflow",
    "runScript",
    "planWorkflow",
    "runDagOnCtx",
    "spawnWorker",
    "runParallel",
    "loopUntilDry",
    "adversarialVerify",
    "selectRoles",
    "workerPrompt"
  ]) {
    assert.strictEqual(typeof engine[name], "function", `engine.${name} must stay exported`);
  }
});
