"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const childProcess = require("child_process");

const { MOCK, freshTmpDir } = require("./helpers/env.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");

function spawnCli(args, env = {}) {
  return childProcess.spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ULTRACODE_UI: "0", ULTRACODE_NO_AUTO_UPDATE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function waitForInvocation(sessionDir, timeoutMs = 10_000) {
  const invocationsPath = path.join(sessionDir, "invocations.log");
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (fs.existsSync(invocationsPath)) {
        const raw = fs.readFileSync(invocationsPath, "utf8");
        if (raw.trim()) {
          resolve(raw);
          return;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`timed out waiting for mock invocation log at ${invocationsPath}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function waitForStderr(child, pattern, timeoutMs = 10_000) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stderr pattern ${pattern}; saw: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (pattern.test(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`process closed before stderr pattern ${pattern}; saw: ${buffer}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("close", onClose);
    };
    child.stderr.on("data", onData);
    child.on("close", onClose);
  });
}

test("CLI run: first SIGINT cancels, prints notice, exits 0 with a persisted cancelled/partial state", async () => {
  const home = freshTmpDir("ultracode-sigint-home-");
  const workers_spec = JSON.stringify([
    { prompt: "slow one", schema: null },
    { prompt: "slow two", schema: null },
    { prompt: "slow three", schema: null }
  ]);
  const child = spawnCli(
    [
      "--workers-spec",
      workers_spec,
      "--cwd",
      home,
      "--codex-bin",
      MOCK,
      "--codex-home",
      home,
      "--concurrency",
      "1"
    ],
    {
      CODEX_HOME: home,
      CODEX_CLI_PATH: MOCK,
      MOCK_CODEX_SESSION_DIR: home,
      MOCK_CODEX_SLEEP_MS: "1500",
      MOCK_CODEX_RESPONSE: "ok"
    }
  );
  const done = collect(child);
  await waitForInvocation(home);
  child.kill("SIGINT");
  const { code, stdout, stderr } = await done;

  assert.match(stderr, /cancelling run/i, "prints the cancel notice");
  assert.strictEqual(code, 0, `exits 0 after a graceful cancel (stderr: ${stderr})`);
  const record = JSON.parse(stdout);
  assert.ok(
    record.status === "cancelled" || record.status === "partial",
    `status should be cancelled/partial, got ${record.status}`
  );
  // The persisted state file exists and matches.
  assert.ok(fs.existsSync(record.state_path), "state file persisted");
  const persisted = JSON.parse(fs.readFileSync(record.state_path, "utf8"));
  assert.strictEqual(persisted.id, record.id);
});

test("CLI run: a second SIGINT forces exit 130", async () => {
  const home = freshTmpDir("ultracode-sigint2-home-");
  const workers_spec = JSON.stringify([{ prompt: "very slow", schema: null }]);
  const child = spawnCli(
    [
      "--workers-spec",
      workers_spec,
      "--cwd",
      home,
      "--codex-bin",
      MOCK,
      "--codex-home",
      home,
      "--concurrency",
      "1"
    ],
    {
      CODEX_HOME: home,
      CODEX_CLI_PATH: MOCK,
      MOCK_CODEX_SESSION_DIR: home,
      MOCK_CODEX_SLEEP_MS: "6000",
      MOCK_CODEX_RESPONSE: "ok",
      // The child ignores SIGTERM so the engine's kill ladder must escalate; this
      // keeps the run in-flight long enough for a second SIGINT to be observed.
      MOCK_CODEX_IGNORE_SIGTERM: "1"
    }
  );
  const done = collect(child);
  await waitForInvocation(home);
  child.kill("SIGINT");
  await waitForStderr(child, /cancelling run/i);
  // Second SIGINT while the first abort is still tearing down => hard-exit 130.
  child.kill("SIGINT");
  const { code, stderr } = await done;
  assert.strictEqual(code, 130, `force-quit exit code 130 (stderr: ${stderr})`);
  assert.match(stderr, /force quit/i);
});

test("CLI workflow list does NOT install the SIGINT handler (unaffected by Ctrl-C wiring)", async () => {
  // workflow list is synchronous and returns immediately; just assert it works and prints.
  const { code, stdout } = await collect(spawnCli(["workflow", "list"], {}));
  assert.strictEqual(code, 0);
  const result = JSON.parse(stdout);
  assert.strictEqual(result.kind, "workflow_definitions");
});
