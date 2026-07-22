"use strict";

const test = require("node:test");
const assert = require("node:assert");
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
    child.stdout.on("data", (c) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c) => {
      stderr += c.toString("utf8");
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("CLI --steps parses JSON, runs the DAG, prints the record", async () => {
  const home = freshTmpDir("ultracode-cli-home-");
  const steps = JSON.stringify([
    { id: "a", prompt: "step a" },
    { id: "b", prompt: "step b using {{steps.a.summary}}", depends_on: ["a"] }
  ]);
  const { code, stdout, stderr } = await runCli(
    ["--steps", steps, "--name", "Plan UI Orb", "--cwd", home, "--codex-bin", MOCK, "--codex-home", home, "--concurrency", "2", "--global-concurrency", "1", "--progress"],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.name, "Plan UI Orb");
  assert.strictEqual(record.options.global_concurrency, 1);
  assert.strictEqual(record.slug, "plan-ui-orb");
  assert.match(record.id, /-plan-ui-orb$/);
  assert.strictEqual(record.options.pipeline, true);
  assert.strictEqual(record.workers.length, 2);
  assert.strictEqual(record.status, "completed");
  // --progress writes events to stderr.
  assert.match(stderr, /\[ultracode\]/, "progress lines emitted to stderr");
});

test("CLI positional steps[] JSON auto-compiles to a DAG (pipeline record)", async () => {
  const home = freshTmpDir("ultracode-cli-home-");
  const steps = JSON.stringify([
    { id: "a", prompt: "step a" },
    { id: "b", prompt: "step b using {{steps.a.summary}}", depends_on: ["a"] }
  ]);
  const { code, stdout, stderr } = await runCli(
    [steps, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.options.pipeline, true, "a bare steps[] array routes to runPipelineSpec");
  assert.strictEqual(record.workers.length, 2);
  assert.strictEqual(record.status, "completed");
});

test("CLI with malformed --steps reports a clean JSON error", async () => {
  const { code, stderr } = await runCli(["--steps", "{not json"], {});
  assert.notStrictEqual(code, 0, "non-zero exit on bad JSON");
  assert.match(stderr, /--steps must be valid JSON/);
});
