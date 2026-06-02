import { formatDate } from "./state.js";

const React = window.React;
const h = React.createElement;

export function RunSwitcher({ runs, activeId, onSelect }) {
  if (!Array.isArray(runs) || runs.length <= 1) return null;
  return h(
    "nav",
    { className: "run-switcher", "aria-label": "Recent Ultracode runs" },
    h("span", { className: "run-switcher-label" }, "Recent"),
    runs.slice(0, 5).map((run) =>
      h(
        "button",
        {
          key: run.id,
          className: `run-switch status-${run.status || "pending"}${run.id === activeId ? " active" : ""}`,
          type: "button",
          onClick: () => onSelect(run.id),
          title: run.name || run.display_name || run.task || run.id
        },
        h("span", { className: "run-switch-dot" }),
        h(
          "span",
          { className: "run-switch-copy" },
          h("strong", null, run.name || run.display_name || run.task || run.id),
          h("small", null, `${run.status || "pending"} / ${formatDate(run.updated_at || run.started_at)}`)
        )
      )
    )
  );
}
