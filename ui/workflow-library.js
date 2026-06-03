import { AlertTriangle, CheckCircle2, FileText, Play, RefreshCcw, Save, Trash2 } from "./icons.js";
import { deleteJson, fetchJson, postJson, putJson } from "./state.js";

const React = window.React;
const { useEffect, useMemo, useState } = React;
const h = React.createElement;

function parseArgs(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed);
}

function scopeLabel(definition) {
  if (!definition) return "";
  return `${definition.scope || "project"} / ${definition.id || definition.name}`;
}

function WorkflowButton({ definition, selected, onSelect }) {
  return h(
    "button",
    {
      className: `workflow-definition-row${selected ? " selected" : ""}${definition.unsupported && definition.unsupported.length ? " has-warning" : ""}`,
      type: "button",
      onClick: () => onSelect(definition.id)
    },
    h("span", { className: "workflow-definition-icon" }, h(FileText, { size: 17 })),
    h(
      "span",
      { className: "workflow-definition-copy" },
      h("strong", null, definition.name || definition.id),
      h("small", null, scopeLabel(definition))
    ),
    definition.unsupported && definition.unsupported.length ? h(AlertTriangle, { size: 16 }) : null
  );
}

function PhaseList({ phases }) {
  const list = Array.isArray(phases) ? phases : [];
  if (list.length === 0) return null;
  return h(
    "div",
    { className: "workflow-phases" },
    list.map((phase, index) =>
      h(
        "div",
        { className: "workflow-phase", key: `${phase.title || "phase"}-${index}` },
        h("strong", null, phase.title || `Phase ${index + 1}`),
        phase.detail ? h("span", null, phase.detail) : null
      )
    )
  );
}

export function WorkflowLibrary({ record, onRunStarted, onError }) {
  const [definitions, setDefinitions] = useState([]);
  const [collapsed, setCollapsed] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [argsDraft, setArgsDraft] = useState("");
  const [saveScope, setSaveScope] = useState("project");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const selectedSummary = useMemo(
    () => definitions.find((definition) => definition.id === selectedId) || definitions[0] || null,
    [definitions, selectedId]
  );

  async function loadDefinitions(preferredId = selectedId) {
    const payload = await fetchJson("/api/workflow-definitions");
    const list = Array.isArray(payload.workflows) ? payload.workflows : [];
    setDefinitions(list);
    const nextId = preferredId && list.some((definition) => definition.id === preferredId) ? preferredId : list[0] && list[0].id;
    setSelectedId(nextId || "");
    return nextId || "";
  }

  async function loadDetail(id) {
    if (!id) {
      setDetail(null);
      setSourceDraft("");
      return;
    }
    const next = await fetchJson(`/api/workflow-definitions/${encodeURIComponent(id)}`);
    setDetail(next);
    setSourceDraft(next.source || "");
  }

  useEffect(() => {
    loadDefinitions().catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    loadDetail(selectedSummary && selectedSummary.id).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }, [selectedSummary && selectedSummary.id]);

  async function refresh() {
    setBusy("refresh");
    try {
      const nextId = await loadDefinitions(selectedId);
      await loadDetail(nextId);
      setMessage("");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function saveCurrentRun() {
    if (!record || !record.id) return;
    const name = window.prompt("Workflow name", (record.meta && record.meta.name) || record.name || record.slug || record.id);
    if (!name || !name.trim()) return;
    setBusy("save-run");
    try {
      const saved = await postJson("/api/workflow-definitions", { workflow_id: record.id, name: name.trim(), scope: saveScope });
      await loadDefinitions(saved.workflow.id);
      await loadDetail(saved.workflow.id);
      setMessage(`Saved "${saved.workflow.name || saved.workflow.id}"`);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function saveDraft() {
    if (!detail || !detail.id) return;
    setBusy("save-draft");
    try {
      await putJson(`/api/workflow-definitions/${encodeURIComponent(detail.id)}`, { source: sourceDraft });
      await loadDefinitions(detail.id);
      await loadDetail(detail.id);
      setMessage("Workflow source saved");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function deleteSelected() {
    if (!detail || !detail.id) return;
    if (!window.confirm(`Delete ${detail.id}?`)) return;
    setBusy("delete");
    try {
      await deleteJson(`/api/workflow-definitions/${encodeURIComponent(detail.id)}`);
      const nextId = await loadDefinitions("");
      await loadDetail(nextId);
      setMessage("Workflow deleted");
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  async function runSelected() {
    if (!detail || !detail.id) return;
    setBusy("run");
    try {
      const launched = await postJson(`/api/workflow-definitions/${encodeURIComponent(detail.id)}/run`, { args: parseArgs(argsDraft) });
      setMessage("Run started");
      if (typeof onRunStarted === "function") onRunStarted(launched.workflow_id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
  }

  return h(
    "section",
    { className: `workflow-library${collapsed ? " collapsed" : ""}` },
    h(
      "div",
      { className: "workflow-library-header" },
      h(
        "button",
        {
          className: "workflow-library-toggle",
          type: "button",
          onClick: () => setCollapsed((current) => !current),
          "aria-expanded": !collapsed
        },
        h("span", null, "Workflows"),
        h("small", null, definitions.length ? `${definitions.length} saved` : "none saved"),
        h("strong", { "aria-hidden": "true" }, collapsed ? "Expand" : "Collapse")
      ),
      collapsed
        ? null
        : h(
            "div",
            { className: "workflow-library-actions" },
            record && record.kind === "script" && record.script_path
              ? h(
                  "button",
                  { className: "workflow-action-button", type: "button", onClick: saveCurrentRun, disabled: Boolean(busy), title: "Save current run" },
                  h(Save, { size: 17 }),
                  h("span", null, "Save run")
                )
              : null,
            h(
              "select",
              {
                className: "workflow-scope-select",
                value: saveScope,
                onChange: (event) => setSaveScope(event.target.value),
                title: "Save scope",
                "aria-label": "Save scope"
              },
              h("option", { value: "project" }, "project"),
              h("option", { value: "user" }, "user")
            ),
            h("button", { className: "icon-button", type: "button", onClick: refresh, disabled: Boolean(busy), title: "Refresh workflows", "aria-label": "Refresh workflows" }, h(RefreshCcw, { size: 17, className: busy === "refresh" ? "spin" : "" }))
          )
    ),
    collapsed
      ? null
      : h(
          "div",
          { className: "workflow-library-grid" },
          h(
            "div",
            { className: "workflow-definition-list" },
            definitions.length
              ? definitions.map((definition) =>
                  h(WorkflowButton, {
                    key: `${definition.scope}-${definition.id}`,
                    definition,
                    selected: detail && detail.id === definition.id,
                    onSelect: setSelectedId
                  })
                )
              : h("div", { className: "workflow-library-empty" }, "No saved workflows")
          ),
          h(
            "div",
            { className: "workflow-definition-detail" },
            detail
              ? [
                  h(
                    "div",
                    { className: "workflow-definition-title", key: "title" },
                    h("div", null, h("strong", null, detail.name || detail.id), h("small", null, detail.path || scopeLabel(detail))),
                    h(
                      "div",
                      { className: "workflow-definition-controls" },
                      h("button", { className: "icon-button", type: "button", onClick: runSelected, disabled: Boolean(busy || (detail.unsupported && detail.unsupported.length)), title: "Run workflow", "aria-label": "Run workflow" }, h(Play, { size: 17 })),
                      h("button", { className: "icon-button", type: "button", onClick: saveDraft, disabled: Boolean(busy), title: "Save changes", "aria-label": "Save changes" }, h(Save, { size: 17 })),
                      h("button", { className: "icon-button danger", type: "button", onClick: deleteSelected, disabled: Boolean(busy), title: "Delete workflow", "aria-label": "Delete workflow" }, h(Trash2, { size: 17 }))
                    )
                  ),
                  detail.description ? h("p", { className: "workflow-definition-description", key: "desc" }, detail.description) : null,
                  h(PhaseList, { phases: detail.phases || [], key: "phases" }),
                  detail.unsupported && detail.unsupported.length
                    ? h(
                        "div",
                        { className: "workflow-definition-warning", key: "warning" },
                        h(AlertTriangle, { size: 17 }),
                        h("span", null, detail.unsupported.join(" "))
                      )
                    : h("div", { className: "workflow-definition-ok", key: "ok" }, h(CheckCircle2, { size: 16 }), h("span", null, "Compatible")),
                  h(
                    "label",
                    { className: "workflow-editor-section", key: "source" },
                    h("span", null, "Workflow source"),
                    h("textarea", {
                      className: "workflow-source-editor",
                      spellCheck: "false",
                      value: sourceDraft,
                      onChange: (event) => setSourceDraft(event.target.value)
                    })
                  ),
                  h(
                    "label",
                    { className: "workflow-editor-section compact", key: "args" },
                    h("span", null, "Run args JSON"),
                    h("textarea", {
                      className: "workflow-args-editor",
                      spellCheck: "false",
                      placeholder: "{\"topic\":\"release readiness\"}",
                      value: argsDraft,
                      onChange: (event) => setArgsDraft(event.target.value)
                    })
                  ),
                  message ? h("div", { className: "workflow-library-message", key: "message" }, message) : null
                ]
              : h("div", { className: "workflow-library-empty" }, "Select a workflow")
          )
        )
  );
}
