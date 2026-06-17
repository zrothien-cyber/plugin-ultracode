"use strict";

function nowIso() {
  return new Date().toISOString();
}

function controllerSnapshot(startedAt) {
  const now = nowIso();
  return {
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

function isLivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") return true;
    return false;
  }
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

function reconcileRunningRecord(record) {
  if (!record || record.status !== "running") return { record, changed: false };
  const controller = record.controller;
  if (!controller || !Number.isInteger(controller.pid)) {
    return { record, changed: false };
  }
  if (isLivePid(controller.pid)) return { record, changed: false };
  const observedAt = nowIso();
  return {
    record: markAbandoned(
      record,
      `controller pid ${controller.pid} is not live; run ended before terminal state was journaled`,
      observedAt
    ),
    changed: true
  };
}

module.exports = {
  controllerSnapshot,
  refreshControllerHeartbeat,
  reconcileRunningRecord,
  isLivePid
};
