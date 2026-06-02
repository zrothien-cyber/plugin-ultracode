const React = window.React;
const h = React.createElement;

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function scalarText(value) {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function JsonScalar({ value }) {
  return h("span", { className: `json-token json-${valueType(value)}` }, scalarText(value));
}

function JsonTable({ value }) {
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value || {});
  if (entries.length === 0) return h("div", { className: "json-empty" }, Array.isArray(value) ? "[]" : "{}");
  return h(
    "table",
    { className: "json-table" },
    h(
      "tbody",
      null,
      entries.map(([key, item]) =>
        h(
          "tr",
          { key },
          h("th", null, key),
          h("td", null, h(JsonValue, { value: item }))
        )
      )
    )
  );
}

function JsonValue({ value }) {
  if (value && typeof value === "object") return h(JsonTable, { value });
  return h(JsonScalar, { value });
}

function parseMaybeJson(text) {
  if (typeof text !== "string") return { parsed: text, isJson: text !== undefined };
  const trimmed = text.trim();
  if (!trimmed) return { parsed: "", isJson: false };
  if (!/^[{\["\-0-9tfn]/.test(trimmed)) return { parsed: text, isJson: false };
  try {
    return { parsed: JSON.parse(trimmed), isJson: true };
  } catch {
    return { parsed: text, isJson: false };
  }
}

export function OutputViewer({ title = "Output", value, danger = false }) {
  const normalized = parseMaybeJson(value);
  const isStructured = normalized.isJson && normalized.parsed && typeof normalized.parsed === "object";
  return h(
    "section",
    { className: `output-viewer${danger ? " danger" : ""}` },
    h("h3", null, title),
    isStructured
      ? h(JsonTable, { value: normalized.parsed })
      : h("pre", { className: "output-code" }, typeof normalized.parsed === "string" ? normalized.parsed : scalarText(normalized.parsed))
  );
}
