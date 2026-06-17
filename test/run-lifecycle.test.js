"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  controllerSnapshot,
  evaluateControllerLiveness,
  reconcileRunningRecord
} = require("../scripts/run-lifecycle");
const { normalizeStartTime } = require("../scripts/process-liveness");

function runningRecord(controller) {
  return {
    id: "pid-reuse-test",
    status: "running",
    started_at: "2026-06-17T00:00:00.000Z",
    completed_at: null,
    controller,
    workers: [{ id: "worker", status: "running" }]
  };
}

test("controllerSnapshot journals command and process start metadata for PID reuse checks", () => {
  const snapshot = controllerSnapshot("2026-06-17T00:00:00.000Z");
  assert.strictEqual(snapshot.pid, process.pid);
  assert.strictEqual(snapshot.platform, process.platform);
  assert.ok(snapshot.invocation, "controller invocation is journaled for diagnostics");
  assert.ok("command_line" in snapshot, "controller command line field is present");
  assert.ok("process_started_at" in snapshot, "controller process start field is journaled");
});

test("Windows CIM process creation dates normalize to ISO timestamps", () => {
  assert.strictEqual(normalizeStartTime("20260617080802.000000+600"), "2026-06-16T22:08:02.000Z");
});

test("controller liveness rejects PID reuse when Windows process start time changed", () => {
  const controller = {
    pid: 4242,
    platform: "win32",
    process_started_at: "2026-06-17T08:08:02.000Z",
    command_line: "C:\\Program Files\\nodejs\\node.exe C:\\tools\\ultracode.js"
  };
  const liveness = evaluateControllerLiveness(controller, {
    lookupProcessIdentity: () => ({
      exists: true,
      pid: 4242,
      platform: "win32",
      process_started_at: "2026-06-17T08:12:02.000Z",
      command_line: controller.command_line
    })
  });
  assert.strictEqual(liveness.live, false);
  assert.match(liveness.reason, /different process start time/);
});

test("controller liveness rejects PID reuse when Windows command line changed", () => {
  const controller = {
    pid: 4242,
    platform: "win32",
    process_started_at: "2026-06-17T08:08:02.000Z",
    command_line: "C:\\Program Files\\nodejs\\node.exe C:\\tools\\ultracode.js"
  };
  const liveness = evaluateControllerLiveness(controller, {
    lookupProcessIdentity: () => ({
      exists: true,
      pid: 4242,
      platform: "win32",
      process_started_at: controller.process_started_at,
      command_line: "C:\\Program Files\\nodejs\\node.exe C:\\other\\script.js"
    })
  });
  assert.strictEqual(liveness.live, false);
  assert.match(liveness.reason, /different command line/);
});

test("reconcileRunningRecord abandons running workers when PID identity is reused", () => {
  const record = runningRecord({
    pid: 4242,
    platform: "win32",
    process_started_at: "2026-06-17T08:08:02.000Z",
    command_line: "C:\\Program Files\\nodejs\\node.exe C:\\tools\\ultracode.js"
  });
  const reconciled = reconcileRunningRecord(record, {
    lookupProcessIdentity: () => ({
      exists: true,
      pid: 4242,
      platform: "win32",
      process_started_at: "2026-06-17T08:08:02.000Z",
      command_line: "C:\\Program Files\\nodejs\\node.exe C:\\different\\controller.js"
    })
  });
  assert.strictEqual(reconciled.changed, true);
  assert.strictEqual(reconciled.record.status, "abandoned");
  assert.match(reconciled.record.abandoned_reason, /different command line/);
  assert.strictEqual(reconciled.record.workers[0].status, "abandoned");
});

test("controller liveness does not reject live PID when no verified identity was journaled", () => {
  const controller = {
    pid: 4242,
    platform: "win32",
    invocation: "node C:\\tools\\ultracode.js"
  };
  const liveness = evaluateControllerLiveness(controller, {
    lookupProcessIdentity: () => ({
      exists: true,
      verified: true,
      pid: 4242,
      platform: "win32",
      process_started_at: "2026-06-17T08:12:02.000Z",
      command_line: "C:\\Program Files\\nodejs\\node.exe C:\\tools\\ultracode.js"
    })
  });
  assert.strictEqual(liveness.live, true);
});
