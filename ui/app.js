import { Activity, AlertTriangle, CheckCircle2, CircleSlash, Clock3, Hourglass } from "./icons.js";
import { JournalPanel } from "./journal-panel.js";
import { WorkflowGraph } from "./graph.js";
import { WorkflowLibrary } from "./workflow-library.js";
import { RunSwitcher } from "./run-switcher.js";
import { HookSessionsPanel } from "./hook-sessions-panel.js";
import { fetchJson, formatDuration, normalizeWorkflow, totalTokens, workflowIdFromLocation } from "./state.js";
import { runModelSettings } from "./model-settings.js";

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
  const agents = Number.isFinite(graph.agent_count) ? graph.agent_count : graph.nodes.length || 0;
  const failed = graph.counts.failed || 0;
  const groups = graph.phases.length || 0;
  const controls = Number.isFinite(graph.control_count) ? graph.control_count : 0;
  const controlText = controls ? ` / ${controls} script ${controls === 1 ? "signal" : "signals"}` : "";
  return h(
    "p",
    { className: "status-sentence" },
    `${agents} agents across ${groups} groups`,
    controlText,
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

function TopBar({ record, graph, error }) {
  const title = record && (record.name || record.display_name || record.task) ? record.name || record.display_name || record.task : record && record.id ? record.id : "Workflow Monitor";
  const id = record && record.id ? record.id : "latest";
  const cwd = record && record.cwd ? record.cwd : "workspace";
  const settings = runModelSettings(record);

  return h(
    "header",
    { className: "topbar" },
    h(
      "div",
      { className: "title-block" },
      h("div", { className: "breadcrumb" }, `~/runs / ultracode / ${id}`),
      h("h1", null, title),
      record ? statusSentence(graph) : h("p", { className: "status-sentence" }, error || `Waiting for a workflow record in ${cwd}.`),
      record
        ? h(
            "div",
            { className: "run-settings", "aria-label": "Run model settings" },
            h("span", null, "Model", h("strong", null, settings.model)),
            h("span", null, "Reasoning", h("strong", null, settings.reasoning))
          )
        : null
    )
  );
}

function App() {
  const [workflowId, setWorkflowId] = useState(workflowIdFromLocation());
  const [record, setRecord] = useState(null);
  const [runs, setRuns] = useState([]);
  const [hookSessions, setHookSessions] = useState([]);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const graph = useMemo(() => normalizeWorkflow(record || {}), [record]);

  async function load(nextId = workflowId) {
    setRefreshing(true);
    try {
      const endpoint = nextId ? `/api/workflows/${encodeURIComponent(nextId)}` : "/api/workflows/latest";
      const [nextRecord, list, sessions] = await Promise.all([fetchJson(endpoint), fetchJson("/api/workflows"), fetchJson("/api/hook-sessions")]);
      setRecord(nextRecord);
      setRuns(Array.isArray(list.workflows) ? list.workflows : []);
      setHookSessions(Array.isArray(sessions.sessions) ? sessions.sessions : []);
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
    setSelectedId((current) => (current === id ? null : id));
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
    h(TopBar, { record, graph, error }),
    error ? h("div", { className: "error-banner" }, h(AlertTriangle, { size: 18 }), h("span", null, error)) : null,
    h(StatsStrip, { record, graph }),
    h(WorkflowGraph, { record: record || {}, graph, selectedId, onSelect: inspectAgent }),
    h(HookSessionsPanel, { sessions: hookSessions }),
    h(JournalPanel, { graph }),
    h(
      "footer",
      { className: "app-footer" },
      h("span", null, "ULTRACODE"),
      h("span", null, record && record.started_at ? `Run ID: ${record.id} / Started ${new Date(record.started_at).toLocaleTimeString()}` : "Run ID: pending")
    )
  );
}

createRoot(document.getElementById("root")).render(h(App));
