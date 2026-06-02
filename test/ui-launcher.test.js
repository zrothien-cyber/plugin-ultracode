"use strict";

const test = require("node:test");
const assert = require("node:assert");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("path");

const { engine, MOCK, freshTmpDir, withCodexHome } = require("./helpers/env.js");
const { metadataPathForRunsDir, shouldLaunchUi } = require("../scripts/ultracode-ui-launcher.js");

const CLI = path.join(__dirname, "..", "scripts", "ultracode-cli.js");

async function fetchJson(url) {
  const response = await fetch(url);
  assert.strictEqual(response.status, 200, `GET ${url} returned ${response.status}`);
  return response.json();
}

async function stopServer(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
}

test("shouldLaunchUi only defaults on when explicitly enabled by input or env", () => {
  const previous = process.env.ULTRACODE_UI;
  try {
    delete process.env.ULTRACODE_UI;
    assert.strictEqual(shouldLaunchUi({}), false);
    assert.strictEqual(shouldLaunchUi({ ui: true }), true);
    assert.strictEqual(shouldLaunchUi({ ui: false }), false);
    process.env.ULTRACODE_UI = "1";
    assert.strictEqual(shouldLaunchUi({}), true);
    process.env.ULTRACODE_UI = "0";
    assert.strictEqual(shouldLaunchUi({}), false);
  } finally {
    if (previous === undefined) delete process.env.ULTRACODE_UI;
    else process.env.ULTRACODE_UI = previous;
  }
});

test("runWorkflow ui:true launches the dashboard server and serves the workflow journal", async () => {
  let serverPid = null;
  await withCodexHome(async (home) => {
    try {
      const events = [];
      const record = await engine.runWorkflow({
        workers_spec: [{ label: "ui-smoke", prompt: "return a tiny UI smoke result", schema: null }],
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        ui: true,
        on_event: (event) => events.push(event)
      });
      serverPid = record.ui && record.ui.server_pid;

      assert.strictEqual(record.status, "completed");
      assert.ok(record.ui, "record includes ui metadata");
      assert.strictEqual(record.ui.status, "ready");
      assert.match(record.ui.url, new RegExp(`/workflow/${record.id}$`));
      assert.ok(events.some((event) => event.type === "ui.ready" && event.url === record.ui.url));

      const metaPath = metadataPathForRunsDir(path.dirname(record.state_path));
      assert.ok(metaPath.endsWith(path.join("ultracode", "ui", "server.json")));

      const health = await fetchJson(`${record.ui.server_url}/api/health`);
      assert.strictEqual(health.ok, true);
      assert.strictEqual(health.pid, serverPid);

      const apiRecord = await fetchJson(`${record.ui.server_url}/api/workflows/${record.id}`);
      assert.strictEqual(apiRecord.id, record.id);
      assert.strictEqual(apiRecord.workers.length, 1);
      assert.strictEqual(apiRecord.ui.url, record.ui.url);

      const htmlResponse = await fetch(record.ui.url);
      assert.strictEqual(htmlResponse.status, 200);
      assert.match(await htmlResponse.text(), /Ultracode Run/);

      for (const asset of [
        "/app.js",
        "/styles.css",
        "/vendor/react.production.min.js",
        "/vendor/react-dom.production.min.js",
        "/vendor/three.module.min.js",
        "/vendor/three.core.min.js"
      ]) {
        const assetResponse = await fetch(`${record.ui.server_url}${asset}`);
        assert.strictEqual(assetResponse.status, 200, `${asset} is served`);
      }
    } finally {
      await stopServer(serverPid);
    }
  });
});

test("CLI run launches the dashboard by default and --no-ui disables it", async () => {
  const home = freshTmpDir("ultracode-cli-ui-");
  let serverPid = null;
  try {
    const workersSpec = JSON.stringify([{ label: "cli-ui", prompt: "cli ui smoke", schema: null }]);
    const env = { ...process.env, CODEX_HOME: home, CODEX_CLI_PATH: MOCK };
    const enabled = childProcess.spawnSync(
      process.execPath,
      [CLI, "run", "--workers-spec", workersSpec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home],
      { env, encoding: "utf8" }
    );
    assert.strictEqual(enabled.status, 0, enabled.stderr);
    const enabledRecord = JSON.parse(enabled.stdout);
    serverPid = enabledRecord.ui && enabledRecord.ui.server_pid;
    assert.strictEqual(enabledRecord.options.ui, true);
    assert.strictEqual(enabledRecord.ui.status, "ready");

    const disabled = childProcess.spawnSync(
      process.execPath,
      [CLI, "run", "--workers-spec", workersSpec, "--cwd", home, "--codex-bin", MOCK, "--codex-home", home, "--no-ui"],
      { env, encoding: "utf8" }
    );
    assert.strictEqual(disabled.status, 0, disabled.stderr);
    const disabledRecord = JSON.parse(disabled.stdout);
    assert.strictEqual(disabledRecord.options.ui, false);
    assert.strictEqual(disabledRecord.ui, undefined);
  } finally {
    await stopServer(serverPid);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
