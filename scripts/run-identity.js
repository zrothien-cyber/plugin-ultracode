"use strict";

const crypto = require("crypto");
const path = require("path");

const RUN_NAME_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "build",
  "by",
  "can",
  "codex",
  "create",
  "explicit",
  "fix",
  "for",
  "from",
  "in",
  "implement",
  "let",
  "lets",
  "make",
  "of",
  "on",
  "or",
  "please",
  "remove",
  "run",
  "step",
  "the",
  "to",
  "ultracode",
  "update",
  "using",
  "we",
  "with",
  "workflow",
  "worker",
  "workers"
]);

function workflowId(slug = "") {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = slug ? `-${slug}` : "";
  return `ultra-${stamp}-${crypto.randomBytes(3).toString("hex")}${suffix}`;
}

function wordsForName(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function titleCaseWord(word) {
  if (/^[A-Z0-9]{2,}$/.test(word)) return word;
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function compactRunName(value, fallback = "Workflow Run") {
  const words = wordsForName(value)
    .filter((word) => !RUN_NAME_STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 3);
  if (words.length === 0) return fallback;
  return words.map(titleCaseWord).join(" ");
}

function slugForName(name) {
  return wordsForName(name)
    .map((word) => word.toLowerCase())
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48);
}

function looksGenericTask(task) {
  return /^\d+\s+(explicit workers|step pipeline)$/i.test(String(task || "").trim());
}

function deriveRunName(input = {}, fallback = "Workflow Run") {
  if (typeof input.name === "string" && input.name.trim()) return compactRunName(input.name, fallback);
  if (typeof input.task === "string" && input.task.trim() && !looksGenericTask(input.task)) {
    return compactRunName(input.task, fallback);
  }
  if (Array.isArray(input.labels) && input.labels.length > 0) {
    return compactRunName(input.labels.filter(Boolean).join(" "), fallback);
  }
  if (typeof input.path === "string" && input.path.trim()) {
    return compactRunName(path.basename(input.path).replace(/\.[^.]+$/, ""), fallback);
  }
  return fallback;
}

function workflowIdentity(input = {}, fallback = "Workflow Run") {
  const name = deriveRunName(input, fallback);
  const slug = slugForName(name);
  return { id: workflowId(slug), name, slug };
}

function recordLabels(record) {
  const items = Array.isArray(record && record.steps) && record.steps.length > 0 ? record.steps : record && record.workers;
  if (!Array.isArray(items)) return [];
  return items.map((item) => item && (item.label || item.title || item.id || item.step_id)).filter(Boolean);
}

function displayRunName(record, fallback = "Workflow Run") {
  if (record && typeof record.name === "string" && record.name.trim()) return record.name.trim();
  if (record && typeof record.task === "string" && record.task.trim() && !looksGenericTask(record.task)) {
    return compactRunName(record.task, fallback);
  }
  const labels = recordLabels(record);
  if (labels.length > 0) return compactRunName(labels.join(" "), fallback);
  return record && record.id ? record.id : fallback;
}

module.exports = {
  compactRunName,
  deriveRunName,
  displayRunName,
  looksGenericTask,
  slugForName,
  workflowIdentity
};
