import { Activity, AlertTriangle, CheckCircle2, CircleSlash, Clock3, Hourglass, Pause, RefreshCcw } from "./icons.js";
import { InspectorPanel } from "./inspector-panel.js";
import { JournalPanel } from "./journal-panel.js";
import { WorkflowGraph } from "./graph.js";
import { RunSwitcher } from "./run-switcher.js";
import { fetchJson, formatDuration, normalizeWorkflow, totalTokens, workflowIdFromLocation } from "./state.js";

const React = window.React;
const { useEffect, useMemo, useState } = React;
const { createRoot } = window.ReactDOM;
const h = React.createElement;

const SUMMARY_ITEMS = [
  { key: "running", label: "Running", icon: Activity },
  { key: "completed", label: "Done", icon: CheckCircle2 },
  { key: "failed", label: "Failed", icon: AlertTriangle },
  { key: "pending", label: "Pending", icon: Clock3 },
  { key: "cancelled", label: "Cancelled", icon: CircleSlash }
];

function statusSentence(graph) {
  const agents = graph.nodes.length || 0;
  const failed = graph.counts.failed || 0;
  const groups = graph.phases.length || 0;
  return h(
    "p",
    { className: "status-sentence" },
    `${agents} agents across ${groups} groups`,
    failed ? h("span", { className: "failure-note" }, ` / ${failed} failures need review`) : h("span", null, " / no failures")
  );
}

function Stat({ label, value, status, icon }) {
  const Icon = icon;
  return h(
    "div",
    { className: `stat status-${status || "neutral"}` },
    h("span", { className: "stat-icon" }, Icon ? h(Icon, { size: 28, strokeWidth: 2 }) : null),
    h("strong", null, value),
    h("span", { className: "stat-label" }, label)
  );
}

function TopBar({ record, graph, onRefresh, refreshing, error }) {
  const duration =
    record && record.started_at
      ? record.duration_ms || (record.completed_at ? Date.parse(record.completed_at) - Date.parse(record.started_at) : Date.now() - Date.parse(record.started_at))
      : null;
  const title = record && (record.name || record.display_name || record.task) ? record.name || record.display_name || record.task : record && record.id ? record.id : "Workflow Monitor";
  const id = record && record.id ? record.id : "latest";
  const cwd = record && record.cwd ? record.cwd : "workspace";
  const canPause = Boolean(record && (record.status === "running" || graph.counts.running > 0));

  return h(
    "header",
    { className: "topbar" },
    h(
      "div",
      { className: "title-block" },
      h("div", { className: "breadcrumb" }, `~/runs / ultracode / ${id}`),
      h("h1", null, title),
      record ? statusSentence(graph) : h("p", { className: "status-sentence" }, error || `Waiting for a workflow record in ${cwd}.`)
    ),
    h(
      "div",
      { className: "topbar-actions" },
      canPause
        ? h(
            "button",
            { className: "primary-control", type: "button", disabled: true, title: "Workflow pause is not exposed by the UI server." },
            h(Pause, { size: 19 }),
            "Pause workflow"
          )
        : null,
      h(
        "button",
        { className: "icon-button", type: "button", onClick: onRefresh, title: "Refresh workflow status", "aria-label": "Refresh workflow status", disabled: refreshing },
        h(RefreshCcw, { size: 18, className: refreshing ? "spin" : "" })
      )
    ),
    h(
      "div",
      { className: "stats-strip" },
      SUMMARY_ITEMS.map((item) => h(Stat, { key: item.key, label: item.label, value: graph.counts[item.key] || 0, status: item.key, icon: item.icon })),
      h(Stat, { label: "Elapsed", value: formatDuration(duration) || "0s", status: "elapsed", icon: Hourglass }),
      h(Stat, { label: "Tokens", value: totalTokens(record).toLocaleString(), status: "tokens", icon: Activity })
    )
  );
}

function App() {
  const [workflowId, setWorkflowId] = useState(workflowIdFromLocation());
  const [record, setRecord] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const graph = useMemo(() => normalizeWorkflow(record || {}), [record]);
  const selected = graph.nodes.find((node) => node.id === selectedId) || graph.nodes[0] || null;

  async function load(nextId = workflowId) {
    setRefreshing(true);
    try {
      const endpoint = nextId ? `/api/workflows/${encodeURIComponent(nextId)}` : "/api/workflows/latest";
      const [nextRecord, list] = await Promise.all([fetchJson(endpoint), fetchJson("/api/workflows")]);
      setRecord(nextRecord);
      setRuns(Array.isArray(list.workflows) ? list.workflows : []);
      setWorkflowId(nextRecord.id);
      setError("");
      setSelectedId((current) => {
        if (current) return current;
        if (!Array.isArray(nextRecord.workers) || nextRecord.workers.length === 0) return current;
        const first = nextRecord.workers[0];
        return first.id || first.step_id || null;
      });
      if (window.location.pathname !== `/workflow/${nextRecord.id}`) {
        window.history.replaceState(null, "", `/workflow/${nextRecord.id}`);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load(workflowId);
    const timer = setInterval(() => load(workflowId), 1000);
    return () => clearInterval(timer);
  }, [workflowId]);

  function selectRun(id) {
    setSelectedId(null);
    setSelectedEvent(null);
    setWorkflowId(id);
    window.history.replaceState(null, "", `/workflow/${id}`);
  }

  function revealInspector() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.querySelector(".inspector-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function inspectAgent(id) {
    setSelectedId(id);
    setSelectedEvent(null);
    revealInspector();
  }

  function inspectJournal(workerId, event) {
    if (workerId) setSelectedId(workerId);
    setSelectedEvent(event || null);
    revealInspector();
  }

  return h(
    "main",
    { className: "app-shell" },
    h(RunSwitcher, { runs, activeId: record && record.id, onSelect: selectRun }),
    h(TopBar, { record, graph, onRefresh: () => load(workflowId), refreshing, error }),
    error ? h("div", { className: "error-banner" }, h(AlertTriangle, { size: 18 }), h("span", null, error)) : null,
    h(WorkflowGraph, { record: record || {}, graph, selectedId: selected && selected.id, onSelect: inspectAgent }),
    h(InspectorPanel, { selected, selectedEvent }),
    h(JournalPanel, { graph, selectedEvent, onInspect: inspectJournal }),
    h(
      "footer",
      { className: "app-footer" },
      h("span", null, "ULTRACODE"),
      h("span", null, "Local Operations Interface for Codex Workers"),
      h("span", null, record && record.started_at ? `Run ID: ${record.id} / Started ${new Date(record.started_at).toLocaleTimeString()}` : "Run ID: pending")
    )
  );
}

createRoot(document.getElementById("root")).render(h(App));
