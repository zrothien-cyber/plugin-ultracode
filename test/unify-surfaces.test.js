"use strict";

// Covers the single unified `ultracode` command (run/pipeline/workflow-run
// collapsed into one) and the in-scope `fanout()` / `dag()` script helpers.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ULTRACODE_UI: "0", ULTRACODE_NO_AUTO_UPDATE: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function source(home, src) {
  return ["--source", src, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home];
}

test("fanout([specs]) runs an arbitrary panel and returns an array of values", async () => {
  const home = freshTmpDir("ultracode-fanout-");
  const src =
    'const r = await fanout([{ prompt: "alpha", schema: null }, { prompt: "beta", schema: null }]);' +
    " return { n: r.length };";
  const { code, stdout, stderr } = await runCli(source(home, src), { CODEX_HOME: home, CODEX_CLI_PATH: MOCK });
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.kind, "script");
  assert.strictEqual(record.result.n, 2);
  assert.strictEqual(record.workers.length, 2, "both panel workers journaled into the script record");
});

test("fanout(task, {workers}) expands the built-in fixed reviewer roles", async () => {
  const home = freshTmpDir("ultracode-fanout-roles-");
  const src = 'const r = await fanout("review the auth refactor", { workers: 3 }); return { n: r.length };';
  const { code, stdout, stderr } = await runCli(source(home, src), { CODEX_HOME: home, CODEX_CLI_PATH: MOCK });
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.result.n, 3, "one worker per selected role");
});

test("dag(steps) runs a depends_on graph and returns an { id: output } map", async () => {
  const home = freshTmpDir("ultracode-dag-");
  const src =
    'const out = await dag([{ id: "a", prompt: "step a" },' +
    ' { id: "b", prompt: "step b using {{steps.a.summary}}", depends_on: ["a"] }]);' +
    " return { ids: Object.keys(out) };";
  const { code, stdout, stderr } = await runCli(source(home, src), { CODEX_HOME: home, CODEX_CLI_PATH: MOCK });
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.deepStrictEqual(record.result.ids, ["a", "b"]);
  assert.strictEqual(record.workers.length, 2, "dag step workers journaled into the script record");
});

test("a bare task sentence routes to a fixed-role fan-out", async () => {
  const home = freshTmpDir("ultracode-task-");
  const { code, stdout, stderr } = await runCli(
    ["Review the auth refactor", "--workers", "2", "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.options.workers, 2);
  assert.strictEqual(record.workers.length, 2);
  assert.strictEqual(record.status, "completed");
});

test("a bare workers_spec[] JSON (no ids) routes to an explicit panel", async () => {
  const home = freshTmpDir("ultracode-panel-");
  const spec = JSON.stringify([{ prompt: "x", label: "one" }, { prompt: "y", label: "two" }]);
  const { code, stdout, stderr } = await runCli(
    [spec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.options.explicit, true, "no-id array -> workers_spec panel (runWorkflow)");
  assert.strictEqual(record.workers.length, 2);
});

test("a multi-line positional (even containing `/`) is inline script source, not a path", async () => {
  const home = freshTmpDir("ultracode-inline-");
  // The `//` comment means the token contains `/`; it must still route to source.
  const src = "const out = { multi: 1 };\n// a /slashy/ comment\nreturn out;";
  const { code, stdout, stderr } = await runCli(
    [src, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.kind, "script");
  assert.deepStrictEqual(record.result, { multi: 1 });
});

test("a positional *.json file auto-compiles to a DAG", async () => {
  const home = freshTmpDir("ultracode-jsonfile-");
  const jsonPath = path.join(home, "steps.json");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify([
      { id: "a", prompt: "step a" },
      { id: "b", prompt: "step b using {{steps.a.summary}}", depends_on: ["a"] }
    ])
  );
  const { code, stdout, stderr } = await runCli(
    [jsonPath, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.options.pipeline, true, "a *.json steps file routes to runPipelineSpec");
  assert.strictEqual(record.workers.length, 2);
});

test("a JSON array mixing id and id-less objects errors clearly", async () => {
  const home = freshTmpDir("ultracode-mixed-");
  const mixed = JSON.stringify([{ id: "a", prompt: "x" }, { prompt: "y" }]);
  const { code, stderr } = await runCli(
    [mixed, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /mixes a pipeline DAG/);
});
