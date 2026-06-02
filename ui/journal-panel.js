import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Database, FileText, Shield } from "./icons.js";
import { compactText, formatDate, outputText } from "./state.js";

const React = window.React;
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

function EventRow({ event, nodes, index, selected, onInspect }) {
  const worker = workerForEvent(event, nodes);
  const status = statusForEvent(event, worker);
  const code = agentCode(worker, index);
  const message = compactText(event.message || event.label || event.type || "", 120);
  return h(
    "button",
    {
      className: `journal-row status-${status}${selected ? " selected" : ""}`,
      type: "button",
      onClick: () => onInspect(worker ? worker.id : null, event)
    },
    h("time", null, formatDate(event.at)),
    h("span", { className: "journal-agent" }, code),
    h("span", { className: "journal-event" }, event.type || "event"),
    h("span", { className: "journal-message" }, message),
    h("span", { className: "journal-output" }, h(OutputIcon, { status }), outputSummary(event, worker, status)),
    h(StatusChip, { status })
  );
}

export function JournalPanel({ graph, selectedEvent, onInspect }) {
  const events = graph.events.slice(-10).reverse();
  const selectedKey = selectedEvent ? `${selectedEvent.at || ""}-${selectedEvent.type || ""}-${selectedEvent.message || ""}` : "";
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
            const eventKey = `${event.at || ""}-${event.type || ""}-${event.message || ""}`;
            return h(EventRow, { event, nodes: graph.nodes, index, selected: selectedKey === eventKey, onInspect, key });
          })
        : h("p", { className: "journal-empty" }, "No journal events recorded yet.")
    )
  );
}
