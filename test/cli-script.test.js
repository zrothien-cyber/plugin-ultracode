"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const childProcess = require("child_process");
const fs = require("fs");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");
const ECHO_FIXTURE = path.join(__dirname, "fixtures", "echo.workflow.js");

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

test("CLI positional *.js path --args runs via the mock and reaches the script scope", async () => {
  const home = freshTmpDir("ultracode-script-cli-");
  const { code, stdout, stderr } = await runCli(
    [ECHO_FIXTURE, "--args", '{"who":"cli"}', "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `cli exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.kind, "script");
  assert.strictEqual(record.name, "Echo");
  assert.strictEqual(record.slug, "echo");
  assert.match(record.id, /-echo$/);
  assert.strictEqual(record.status, "completed");
  assert.strictEqual(record.result.who, "cli", "--args JSON reached the script scope");
});

test("CLI --path and --source both work; --source runs inline", async () => {
  const home = freshTmpDir("ultracode-script-cli-");
  const byPath = await runCli(
    ["--path", ECHO_FIXTURE, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(byPath.code, 0, `--path exited 0 (stderr: ${byPath.stderr})`);
  assert.strictEqual(JSON.parse(byPath.stdout).status, "completed");

  const home2 = freshTmpDir("ultracode-script-cli-");
  const bySource = await runCli(
    ["--source", "return { hi: 1 };", "--cwd", home2, "--codex-bin", MOCK, "--codex-home", home2],
    { CODEX_HOME: home2, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(bySource.code, 0, `--source exited 0 (stderr: ${bySource.stderr})`);
  assert.deepStrictEqual(JSON.parse(bySource.stdout).result, { hi: 1 });
});

test("CLI with malformed --args reports a clean JSON error", async () => {
  const { code, stderr } = await runCli(["--source", "return 1;", "--args", "{not json"], {});
  assert.notStrictEqual(code, 0, "non-zero exit on bad JSON");
  assert.match(stderr, /--args must be valid JSON/);
});

test("CLI with no input errors with a usage hint", async () => {
  const { code, stderr } = await runCli([], {});
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /Nothing to run/);
  assert.match(stderr, /resume\|status\|workflow/);
});

test("CLI @name runs a saved project .claude/workflows definition", async () => {
  const home = freshTmpDir("ultracode-workflow-cli-");
  const dir = path.join(home, ".claude", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "echo.js"),
    [
      'export const meta = { name: "Echo Workflow", description: "Named workflow" };',
      'phase("echo");',
      'const value = await agent(`echo ${args.who}`);',
      'return { who: args.who, ok: value !== null };'
    ].join("\n")
  );
  const { code, stdout, stderr } = await runCli(
    ["@echo", "--args", '{"who":"named"}', "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `@echo exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.kind, "script");
  assert.strictEqual(record.name, "Echo");
  assert.strictEqual(record.meta.name, "Echo Workflow");
  assert.strictEqual(record.result.who, "named");
  assert.strictEqual(record.meta.description, "Named workflow");
  assert.ok(record.script_path && fs.existsSync(record.script_path), "script snapshot was written");
  assert.ok(record.definition_ref && record.definition_ref.id === "echo");
});

test("CLI --workflow <name> runs a saved definition (same path as @name)", async () => {
  const home = freshTmpDir("ultracode-workflow-flag-");
  const dir = path.join(home, ".claude", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "echo.js"),
    [
      'export const meta = { name: "Echo Workflow", description: "Named workflow" };',
      'const value = await agent(`echo ${args.who}`);',
      'return { who: args.who, ok: value !== null };'
    ].join("\n")
  );
  const { code, stdout, stderr } = await runCli(
    ["--workflow", "echo", "--args", '{"who":"flag"}', "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
    { CODEX_HOME: home, CODEX_CLI_PATH: MOCK }
  );
  assert.strictEqual(code, 0, `--workflow exited 0 (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.strictEqual(record.kind, "script");
  assert.strictEqual(record.result.who, "flag");
  assert.ok(record.definition_ref && record.definition_ref.id === "echo");
});
