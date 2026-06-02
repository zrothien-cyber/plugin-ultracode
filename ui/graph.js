import {
  BookOpen,
  Code2,
  Database,
  FileText,
  FlaskConical,
  ListChecks,
  Search,
  Shield,
  Wrench
} from "./icons.js";
import { formatDuration } from "./state.js";
import { OrbScene } from "./orb-scene.js";

const React = window.React;
const { useLayoutEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

const STATUS_LABELS = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  pending: "Pending",
  cancelled: "Cancelled"
};

function iconForGroup(label) {
  const normalized = String(label || "").toLowerCase();
  const props = { size: 22, strokeWidth: 2.2 };
  if (normalized.includes("review") || normalized.includes("audit")) return h(Search, props);
  if (normalized.includes("security")) return h(Shield, props);
  if (normalized.includes("implement") || normalized.includes("patch") || normalized.includes("build")) return h(Code2, props);
  if (normalized.includes("test")) return h(FlaskConical, props);
  return h(ListChecks, props);
}

function iconForNode(node) {
  const text = `${node.kind || ""} ${node.title || ""} ${node.label || ""}`.toLowerCase();
  const props = { size: 17, strokeWidth: 2.15 };
  if (text.includes("review") || text.includes("scan") || text.includes("audit")) return h(Search, props);
  if (text.includes("security") || text.includes("risk")) return h(Shield, props);
  if (text.includes("db") || text.includes("database") || text.includes("migration")) return h(Database, props);
  if (text.includes("test") || text.includes("harness")) return h(FlaskConical, props);
  if (text.includes("config") || text.includes("update")) return h(Wrench, props);
  if (text.includes("doc")) return h(BookOpen, props);
  if (text.includes("code") || text.includes("patch") || text.includes("schema") || text.includes("api")) return h(Code2, props);
  return h(FileText, props);
}

function groupCode(label, index) {
  const letters = String(label || "WK")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return `${letters || "WK"}-${String(index + 1).padStart(2, "0")}`;
}

function nodeMetric(node) {
  if (Number.isFinite(node.duration_ms)) return formatDuration(node.duration_ms);
  const tokens = node.usage && Number.isFinite(node.usage.total_tokens) ? node.usage.total_tokens : null;
  if (tokens !== null) return `${tokens.toLocaleString()} tok`;
  return node.status === "pending" ? "queued" : "";
}

function StatusChip({ status }) {
  return h("span", { className: `ledger-chip status-${status || "pending"}` }, STATUS_LABELS[status] || "Pending");
}

function AgentNode({ node, code, selected, onSelect, setNodeRef }) {
  return h(
    "button",
    {
      ref: (element) => setNodeRef(node.id, element),
      className: `agent-node status-${node.status || "pending"}${selected ? " selected" : ""}`,
      onClick: () => onSelect(node.id),
      type: "button",
      title: node.last_message || node.title
    },
    h("span", { className: "agent-code" }, code),
    h("span", { className: "agent-glyph" }, iconForNode(node)),
    h("span", { className: "agent-title" }, node.title),
    h("span", { className: "agent-time" }, nodeMetric(node)),
    h(StatusChip, { status: node.status })
  );
}

function circleAt(x, y, size = 10) {
  return { x, y, size };
}

function measuredConnectors(rootElement, laneElements, nodeElements) {
  const rootBox = rootElement.getBoundingClientRect();
  const orbBox = rootElement.querySelector(".controller-orb")?.getBoundingClientRect();
  if (!orbBox || rootBox.width <= 0 || rootBox.height <= 0) return null;

  const orbX = orbBox.left + orbBox.width / 2 - rootBox.left;
  const orbStartY = orbBox.top + orbBox.height * 0.8 - rootBox.top;
  const routeY = orbStartY + 104;
  const paths = [`M ${orbX} ${orbStartY} L ${orbX} ${routeY}`];
  const circles = [circleAt(orbX, routeY, 11)];

  laneElements.forEach(([laneId, laneElement]) => {
    if (!laneElement) return;
    const laneNodes = nodeElements
      .filter((entry) => entry.laneId === laneId && entry.element)
      .map((entry) => {
        const box = entry.element.getBoundingClientRect();
        return {
          x: box.left - rootBox.left,
          y: box.top + box.height / 2 - rootBox.top
        };
      });
    const laneBox = laneElement.getBoundingClientRect();
    const nodeLeftX = laneNodes.length ? Math.min(...laneNodes.map((node) => node.x)) : laneBox.left - rootBox.left + 34;
    const railX = Math.max(0, nodeLeftX - 44);
    const railTopY = laneNodes.length ? Math.min(routeY, Math.min(...laneNodes.map((node) => node.y))) : routeY;
    const railBottomY = laneNodes.length ? Math.max(...laneNodes.map((node) => node.y)) : routeY;

    paths.push(`M ${orbX} ${routeY} L ${railX} ${routeY}`);
    paths.push(`M ${railX} ${railTopY} L ${railX} ${railBottomY}`);

    laneNodes.forEach((node) => {
      paths.push(`M ${railX} ${node.y} L ${node.x} ${node.y}`);
      circles.push(circleAt(railX, node.y, 10));
    });
  });

  return {
    width: rootBox.width,
    height: rootBox.height,
    paths,
    circles
  };
}

function ConnectorLayer({ connectors }) {
  if (!connectors) return null;
  return h(
    "svg",
    {
      className: "connector-layer",
      viewBox: `0 0 ${connectors.width} ${connectors.height}`,
      width: connectors.width,
      height: connectors.height,
      "aria-hidden": "true"
    },
    connectors.paths.map((path, index) => h("path", { key: `path-${index}`, className: "connector-line", d: path })),
    connectors.circles.map((circle, index) =>
      h("circle", { key: `circle-${index}`, className: "connector-dot", cx: circle.x, cy: circle.y, r: circle.size / 2 })
    )
  );
}

export function WorkflowGraph({ record, graph, selectedId, onSelect }) {
  const groups = graph.phases.length ? graph.phases : [{ id: "Workflow", label: "Workflow", nodes: [] }];
  const rootRef = useRef(null);
  const laneRefs = useRef(new Map());
  const nodeRefs = useRef(new Map());
  const [connectors, setConnectors] = useState(null);
  const layoutKey = useMemo(
    () => groups.map((group) => `${group.id}:${group.nodes.map((node) => `${node.id}:${node.status || "pending"}`).join(",")}`).join("|"),
    [groups]
  );

  function setLaneRef(id, element) {
    if (element) laneRefs.current.set(id, element);
    else laneRefs.current.delete(id);
  }

  function setNodeRef(id, element) {
    if (element) nodeRefs.current.set(id, element);
    else nodeRefs.current.delete(id);
  }

  useLayoutEffect(() => {
    if (!rootRef.current) return undefined;
    const updateConnectors = () => {
      const lanes = groups.map((group) => [group.id, laneRefs.current.get(group.id)]).filter(([, element]) => element);
      const nodes = groups.flatMap((group) =>
        group.nodes.map((node) => ({
          laneId: group.id,
          element: nodeRefs.current.get(node.id)
        }))
      );
      setConnectors(measuredConnectors(rootRef.current, lanes, nodes));
    };

    updateConnectors();
    const resizeObserver = new ResizeObserver(updateConnectors);
    resizeObserver.observe(rootRef.current);
    laneRefs.current.forEach((element) => resizeObserver.observe(element));
    nodeRefs.current.forEach((element) => resizeObserver.observe(element));
    window.addEventListener("resize", updateConnectors);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateConnectors);
    };
  }, [layoutKey]);

  return h(
    "section",
    { className: "workflow-graph", ref: rootRef, "aria-label": "Workflow execution tree" },
    h(OrbScene, { record, graph }),
    h(ConnectorLayer, { connectors }),
    h(
      "div",
      { className: "phase-grid" },
      groups.map((group) =>
        h(
          "section",
          { className: "phase-lane", key: group.id, ref: (element) => setLaneRef(group.id, element) },
          h(
            "header",
            { className: "phase-heading" },
            h("span", { className: "phase-icon" }, iconForGroup(group.label)),
            h("strong", null, group.label),
            h("span", null, `${group.nodes.length} agents`)
          ),
          h(
            "div",
            { className: "node-stack" },
            group.nodes.length
              ? group.nodes.map((node, index) =>
                  h(AgentNode, {
                    key: node.id,
                    node,
                    code: groupCode(group.label, index),
                    selected: node.id === selectedId,
                    onSelect,
                    setNodeRef
                  })
                )
              : h("p", { className: "empty-lane" }, "No workers in this group.")
          )
        )
      )
    )
  );
}
