import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Database, FileText, Shield } from "./icons.js";
import { compactText, formatDate, fullOutputText, fullText, outputText } from "./state.js";
import { OutputViewer } from "./output-viewer.js";

const React = window.React;
const { useState } = React;
const h = React.createElement;

const STATUS_LABELS = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  pending: "Pending",
  cancelled: "Cancelled"
};

function workerKeys(worker) {
  return new Set([worker.id, worker.step_id, worker.label, worker.title].filter(Boolean));
}

function eventMatchesWorker(event, worker) {
  const data = event.data || {};
  const keys = workerKeys(worker);
  return (
    keys.has(event.id) ||
    keys.has(event.step_id) ||
    keys.has(event.label) ||
    keys.has(data.id) ||
    keys.has(data.step_id) ||
    keys.has(data.label) ||
    event.worker_index === worker.index ||
    data.worker_index === worker.index
  );
}

function workerForEvent(event, nodes) {
  return nodes.find((node) => eventMatchesWorker(event, node)) || null;
}

function statusForEvent(event, worker) {
  if (event.status) return event.status;
  if (worker && worker.status) return worker.status;
  if (event.type === "worker.failed" || event.type === "failed") return "failed";
  if (event.type === "worker.completed" || event.type === "completed") return "completed";
  if (event.type === "worker.cancelled" || event.type === "cancelled") return "cancelled";
  if (event.type === "worker.started" || event.type === "step.started") return "running";
  return "pending";
}

function agentCode(worker, index) {
  if (!worker) return "WF";
  const phase = String(worker.phase || "WK")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return `${phase || "WK"}-${String((worker.index ?? index) + 1).padStart(2, "0")}`;
}

function outputSummary(event, worker, status) {
  const data = event.data || {};
  if (status === "failed") return event.error || data.error || outputText(worker) || "error";
  if (worker && worker.usage && Number.isFinite(worker.usage.total_tokens)) return `${worker.usage.total_tokens.toLocaleString()} tokens`;
  if (data.output) return compactText(data.output, 80);
  if (data.path) return data.path;
  return outputText(worker) || "journal";
}

function OutputIcon({ status }) {
  const props = { size: 16, strokeWidth: 2.1 };
  if (status === "failed") return h(AlertTriangle, props);
  if (status === "cancelled") return h(CircleSlash, props);
  if (status === "running") return h(Database, props);
  if (status === "completed") return h(CheckCircle2, props);
  if (status === "pending") return h(Clock3, props);
  return h(FileText, props);
}

function StatusChip({ status }) {
  return h("span", { className: `ledger-chip status-${status || "pending"}` }, STATUS_LABELS[status] || "Pending");
}

function eventKey(event, index) {
  return `${event.at || ""}-${event.type || ""}-${event.message || ""}-${index}`;
}

function EventDetails({ event, worker, status }) {
  const workerOutput = fullOutputText(worker);
  const prompt = worker && worker.spec && worker.spec.prompt ? fullText(worker.spec.prompt) : "";
  const eventOutput = fullText(event);
  const danger = status === "failed" || Boolean(event && (event.error || (event.data && event.data.error)));
  return h(
    "div",
    { className: "journal-details" },
    workerOutput
      ? h(OutputViewer, {
          title: worker && worker.error ? "Error" : "Output",
          value: workerOutput,
          danger: Boolean(worker && worker.error)
        })
      : null,
    eventOutput ? h(OutputViewer, { title: "Full Journal Event", value: eventOutput, danger }) : null,
    prompt ? h(OutputViewer, { title: "Prompt", value: prompt }) : null
  );
}

function EventRow({ event, nodes, index, expanded, onToggle, onSelectWorker }) {
  const worker = workerForEvent(event, nodes);
  const status = statusForEvent(event, worker);
  const code = agentCode(worker, index);
  const message = compactText(event.message || event.label || event.type || "", 120);
  return h(
    "article",
    { className: `journal-entry status-${status}${expanded ? " selected" : ""}` },
    h(
      "button",
      {
        className: "journal-row",
        type: "button",
        onClick: () => {
          if (worker && typeof onSelectWorker === "function") onSelectWorker(worker.id);
          onToggle();
        },
        "aria-expanded": expanded
      },
      h("time", null, formatDate(event.at)),
      h("span", { className: "journal-agent" }, code),
      h("span", { className: "journal-event" }, event.type || "event"),
      h("span", { className: "journal-message" }, message),
      h("span", { className: "journal-output" }, h(OutputIcon, { status }), outputSummary(event, worker, status)),
      h(StatusChip, { status })
    ),
    expanded ? h(EventDetails, { event, worker, status }) : null
  );
}

export function JournalPanel({ graph, onSelectWorker }) {
  const [expandedKey, setExpandedKey] = useState("");
  const events = graph.events.slice(-10).reverse();
  return h(
    "section",
    { className: "journal-panel", "aria-label": "Workflow journal" },
    h(
      "header",
      { className: "journal-heading" },
      h("div", null, h(FileText, { size: 20 }), h("h2", null, "Journal")),
      h("span", { className: "live-indicator" }, h(Shield, { size: 14 }), "Live")
    ),
    h(
      "div",
      { className: "journal-table" },
      h(
        "div",
        { className: "journal-row journal-head" },
        h("span", null, "Time"),
        h("span", null, "Agent"),
        h("span", null, "Event"),
        h("span", null, "Message"),
        h("span", null, "Output / Error"),
        h("span", null, "Status")
      ),
      events.length
        ? events.map((event, index) => {
            const key = `${event.at || ""}-${event.type || ""}-${index}`;
            const rowKey = eventKey(event, index);
            return h(EventRow, {
              event,
              nodes: graph.nodes,
              index,
              expanded: expandedKey === rowKey,
              onToggle: () => setExpandedKey((current) => (current === rowKey ? "" : rowKey)),
              onSelectWorker,
              key
            });
          })
        : h("p", { className: "journal-empty" }, "No journal events recorded yet.")
    )
  );
}
