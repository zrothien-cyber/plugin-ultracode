import { AlertTriangle, CheckCircle2, CircleDot, Clock3, FileText, Layers3, TimerReset } from "./icons.js";
import { compactText, formatDate, formatDuration, fullOutputText, fullText } from "./state.js";

const React = window.React;
const h = React.createElement;

function StatusIcon({ status }) {
  const props = { size: 19, strokeWidth: 2.2 };
  if (status === "completed") return h(CheckCircle2, props);
  if (status === "failed") return h(AlertTriangle, props);
  if (status === "running") return h(TimerReset, props);
  return h(Clock3, props);
}

function Fact({ icon, label, value }) {
  if (value === undefined || value === null || value === "") return null;
  return h("span", { className: "inspector-fact" }, icon, h("span", null, label), h("strong", null, value));
}

function Section({ className = "", title, children }) {
  if (!children) return null;
  return h("section", { className: `inspector-section ${className}`.trim() }, h("h3", null, title), children);
}

function eventText(event) {
  if (!event) return "";
  return fullText(event);
}

export function InspectorPanel({ selected, selectedEvent }) {
  if (!selected && !selectedEvent) return null;

  const title = selected ? selected.title : selectedEvent.type || "Journal event";
  const status = selected ? selected.status : selectedEvent.status || "pending";
  const output = fullOutputText(selected);
  const prompt = selected && selected.spec && selected.spec.prompt ? fullText(selected.spec.prompt) : "";
  const eventOutput = eventText(selectedEvent);
  const usage = selected && selected.usage && Number.isFinite(selected.usage.total_tokens) ? selected.usage.total_tokens.toLocaleString() : "";
  const lastMessage = selected ? selected.last_message || selected.status || "" : selectedEvent.message || "";
  const selectedOutput = selected ? output || "No output recorded yet." : "";

  return h(
    "aside",
    { className: `inspector-panel status-${status || "pending"}`, "aria-label": "Selected agent output" },
    h(
      "header",
      { className: "inspector-heading" },
      h("div", { className: "inspector-status" }, h(StatusIcon, { status })),
      h("div", { className: "inspector-title" }, h("h2", null, title), h("p", null, compactText(lastMessage, 180))),
      h(
        "div",
        { className: "inspector-facts" },
        h(Fact, { icon: h(Layers3, { size: 15 }), label: "Phase", value: selected && selected.phase }),
        h(Fact, { icon: h(TimerReset, { size: 15 }), label: "Duration", value: selected && formatDuration(selected.duration_ms) }),
        h(Fact, { icon: h(CircleDot, { size: 15 }), label: "Tokens", value: usage }),
        h(Fact, { icon: h(FileText, { size: 15 }), label: "Event", value: selectedEvent && selectedEvent.type }),
        h(Fact, { icon: h(Clock3, { size: 15 }), label: "At", value: selectedEvent && formatDate(selectedEvent.at) })
      )
    ),
    h(Section, { className: selected && selected.error ? "danger" : "", title: selected && selected.error ? "Error" : "Output", children: selectedOutput ? h("pre", null, selectedOutput) : null }),
    h(Section, { className: selectedEvent && (selectedEvent.error || (selectedEvent.data && selectedEvent.data.error)) ? "danger" : "", title: "Full Journal Event", children: eventOutput ? h("pre", null, eventOutput) : null }),
    h(Section, { title: "Prompt", children: prompt ? h("pre", null, prompt) : null })
  );
}
