"use strict";

const {
  currentProcessIdentity,
  isLivePid,
  lookupProcessIdentity,
  sameCommandLine,
  sameStartTime
} = require("./process-liveness");

function nowIso() {
  return new Date().toISOString();
}

function controllerSnapshot(startedAt) {
  const now = nowIso();
  const identity = currentProcessIdentity(startedAt || now);
  return {
    ...identity,
    pid: process.pid,
    started_at: startedAt || now,
    heartbeat_at: now,
    platform: process.platform
  };
}

function refreshControllerHeartbeat(record) {
  if (!record || !record.controller || record.status !== "running") return record;
  record.controller.heartbeat_at = nowIso();
  return record;
}

function markWorkerAbandoned(worker) {
  if (!worker || typeof worker !== "object") return worker;
  if (worker.status !== "pending" && worker.status !== "running") return worker;
  return {
    ...worker,
    status: "abandoned",
    error: worker.error || "controller process exited before terminal worker state was journaled"
  };
}

function markAbandoned(record, reason, observedAt) {
  const next = { ...record };
  next.status = "abandoned";
  next.observed_status = "abandoned";
  next.completed_at = next.completed_at || observedAt;
  if (next.started_at && !next.duration_ms) {
    next.duration_ms = Date.parse(next.completed_at) - Date.parse(next.started_at);
  }
  next.abandoned_reason = reason;
  next.observed_at = observedAt;
  if (Array.isArray(next.workers)) next.workers = next.workers.map(markWorkerAbandoned);
  if (Array.isArray(next.steps) && next.steps !== next.workers) next.steps = next.steps.map(markWorkerAbandoned);
  return next;
}

function evaluateControllerLiveness(controller, options = {}) {
  if (!controller || !Number.isInteger(controller.pid)) {
    return { live: null, reason: "controller pid was not journaled" };
  }
  const platform = controller.platform || process.platform;
  const lookup = options.lookupProcessIdentity || lookupProcessIdentity;
  const observed = lookup(controller.pid, platform);
  if (!observed || observed.exists === false) {
    return {
      live: false,
      reason: `controller pid ${controller.pid} is not live; run ended before terminal state was journaled`
    };
  }

  if (controller.process_started_at && observed.process_started_at) {
    if (!sameStartTime(controller.process_started_at, observed.process_started_at)) {
      return {
        live: false,
        reason: `controller pid ${controller.pid} belongs to a different process start time`
      };
    }
  }

  if (controller.command_line && observed.command_line) {
    if (!sameCommandLine(controller.command_line, observed.command_line, platform)) {
      return {
        live: false,
        reason: `controller pid ${controller.pid} belongs to a different command line`
      };
    }
  }

  return { live: true };
}

function reconcileRunningRecord(record, options = {}) {
  if (!record || record.status !== "running") return { record, changed: false };
  const controller = record.controller;
  if (!controller || !Number.isInteger(controller.pid)) {
    return { record, changed: false };
  }
  const liveness = evaluateControllerLiveness(controller, options);
  if (liveness.live !== false) return { record, changed: false };
  const observedAt = nowIso();
  return {
    record: markAbandoned(
      record,
      liveness.reason,
      observedAt
    ),
    changed: true
  };
}

module.exports = {
  controllerSnapshot,
  evaluateControllerLiveness,
  refreshControllerHeartbeat,
  reconcileRunningRecord,
  isLivePid
};
