import { Activity, AlertTriangle, CheckCircle2, CircleSlash, Clock3, Hourglass } from "./icons.js";
import { JournalPanel } from "./journal-panel.js";
import { WorkflowGraph } from "./graph.js";
import { WorkflowLibrary } from "./workflow-library.js";
import { RunSwitcher } from "./run-switcher.js";
import { DetailPanel } from "./detail-panel.js";
import { fetchJson, formatDuration, normalizeWorkflow, totalTokens, workflowIdFromLocation } from "./state.js";

const React = window.React;
const { useEffect, useMemo, useState } = React;
const { createRoot } = window.ReactDOM;
const h = React.createElement;

const SUMMARY_ITEMS = [
  { key: "completed", label: "Done", icon: CheckCircle2 },
  { key: "failed", label: "Failed", icon: AlertTriangle },
  { key: "running", label: "Running", icon: Activity },
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
    { className: `stat status-${status || "neutral"}`, "data-stat": status || "neutral" },
    h("span", { className: "stat-icon" }, Icon ? h(Icon, { size: 28, strokeWidth: 2 }) : null),
    h("strong", null, value),
    h("span", { className: "stat-label" }, label)
  );
}

function StatsStrip({ record, graph }) {
  const duration =
    record && record.started_at
      ? record.duration_ms || (record.completed_at ? Date.parse(record.completed_at) - Date.parse(record.started_at) : Date.now() - Date.parse(record.started_at))
      : null;
  return h(
    "div",
    { className: "stats-strip" },
    SUMMARY_ITEMS.map((item) => h(Stat, { key: item.key, label: item.label, value: graph.counts[item.key] || 0, status: item.key, icon: item.icon })),
    h(Stat, { label: "Elapsed", value: formatDuration(duration) || "0s", status: "elapsed", icon: Hourglass }),
    h(Stat, { label: "Tokens", value: totalTokens(record).toLocaleString(), status: "tokens", icon: Activity })
  );
}

function TopBar({ record, graph, refreshing, error }) {
  const title = record && (record.name || record.display_name || record.task) ? record.name || record.display_name || record.task : record && record.id ? record.id : "Workflow Monitor";
  const id = record && record.id ? record.id : "latest";
  const cwd = record && record.cwd ? record.cwd : "workspace";
  const status = record && record.status ? record.status : graph.counts.running ? "running" : graph.counts.failed ? "failed" : graph.counts.completed ? "completed" : "pending";

  return h(
    "header",
    { className: "topbar" },
    h(
      "div",
      { className: "title-block" },
      h(
        "div",
        { className: "breadcrumb-row" },
        h("div", { className: "breadcrumb" }, `~/runs / ultracode / ${id}`),
        h(
          "div",
          { className: "topbar-signals" },
          h("span", { className: `refresh-pill${refreshing ? " refreshing" : ""}` }, refreshing ? "Syncing" : "Live"),
          h("span", { className: `run-state-pill status-${status}` }, status)
        )
      ),
      h("h1", null, title),
      record ? statusSentence(graph) : h("p", { className: "status-sentence" }, error || `Waiting for a workflow record in ${cwd}.`)
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
  const graph = useMemo(() => normalizeWorkflow(record || {}), [record]);
  const selected =
    graph.nodes.find((node) => node.id === selectedId) ||
    graph.nodes.find((node) => node.status === "failed") ||
    graph.nodes.find((node) => node.status === "running") ||
    graph.nodes[0] ||
    null;

  async function load(nextId = workflowId) {
    setRefreshing(true);
    try {
      const endpoint = nextId ? `/api/workflows/${encodeURIComponent(nextId)}` : "/api/workflows/latest";
      const [nextRecord, list] = await Promise.all([fetchJson(endpoint), fetchJson("/api/workflows")]);
      setRecord(nextRecord);
      setRuns(Array.isArray(list.workflows) ? list.workflows : []);
      setWorkflowId(nextRecord.id);
      setError("");
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
    setWorkflowId(id);
    window.history.replaceState(null, "", `/workflow/${id}`);
  }

  function inspectAgent(id) {
    setSelectedId(id);
  }

  function runStarted(id) {
    if (!id) return;
    selectRun(id);
    load(id);
  }

  return h(
    "main",
    { className: "app-shell" },
    h(WorkflowLibrary, { record, onRunStarted: runStarted, onError: setError }),
    h(RunSwitcher, { runs, activeId: record && record.id, onSelect: selectRun }),
    h(TopBar, { record, graph, refreshing, error }),
    error ? h("div", { className: "error-banner" }, h(AlertTriangle, { size: 18 }), h("span", null, error)) : null,
    h(StatsStrip, { record, graph }),
    h(
      "section",
      { className: "workflow-workspace" },
      h(WorkflowGraph, { record: record || {}, graph, selectedId: selected && selected.id, onSelect: inspectAgent }),
      h(DetailPanel, { selected, events: graph.events, record })
    ),
    h(JournalPanel, { graph, onSelectWorker: inspectAgent }),
    h(
      "footer",
      { className: "app-footer" },
      h("span", null, "ULTRACODE"),
      h("span", null, record && record.started_at ? `Run ID: ${record.id} / Started ${new Date(record.started_at).toLocaleTimeString()}` : "Run ID: pending")
    )
  );
}

createRoot(document.getElementById("root")).render(h(App));
