import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Clock3
} from "./icons.js";
import { agentDisplayCode, formatDuration } from "./state.js";
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

function normalizeStatus(status) {
  if (status === "completed" || status === "failed" || status === "running" || status === "cancelled") return status;
  return "pending";
}

function aggregateStatus(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return "pending";
  if (nodes.some((node) => normalizeStatus(node.status) === "failed")) return "failed";
  if (nodes.some((node) => normalizeStatus(node.status) === "running")) return "running";
  if (nodes.some((node) => normalizeStatus(node.status) === "cancelled")) return "cancelled";
  if (nodes.every((node) => normalizeStatus(node.status) === "completed")) return "completed";
  return "pending";
}

function graphStatus(record, groups) {
  const recordStatus = normalizeStatus(record?.status);
  if (recordStatus !== "pending") return recordStatus;
  return aggregateStatus(groups.flatMap((group) => group.nodes || []));
}

function iconForStatus(status, props) {
  const normalized = normalizeStatus(status);
  if (normalized === "completed") return h(CheckCircle2, props);
  if (normalized === "failed") return h(AlertTriangle, props);
  if (normalized === "running") return h(Activity, props);
  if (normalized === "cancelled") return h(CircleSlash, props);
  return h(Clock3, props);
}

function iconForGroupStatus(status) {
  return iconForStatus(status, { size: 22, strokeWidth: 2.2 });
}

function iconForNodeStatus(status) {
  return iconForStatus(status, { size: 17, strokeWidth: 2.15 });
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
    "article",
    {
      ref: (element) => setNodeRef(node.id, element),
      className: `agent-node status-${node.status || "pending"}${selected ? " selected" : ""}`,
      title: node.last_message || node.title
    },
    h(
      "button",
      {
        className: "agent-node-summary",
        onClick: () => onSelect(node.id),
        type: "button"
      },
      h("span", { className: "agent-code" }, code),
      h("span", { className: `agent-glyph status-${normalizeStatus(node.status)}` }, iconForNodeStatus(node.status)),
      h("span", { className: "agent-title" }, node.title),
      h("span", { className: "agent-time" }, nodeMetric(node)),
      h(StatusChip, { status: node.status })
    )
  );
}

function connectorPath(d, status, animated = false) {
  return { d, status: normalizeStatus(status), animated };
}

function circleAt(x, y, size = 10, status = "pending") {
  return { x, y, size, status: normalizeStatus(status) };
}

function measuredConnectors(rootElement, laneElements, nodeElements, status) {
  const rootBox = rootElement.getBoundingClientRect();
  const orbBox = rootElement.querySelector(".controller-orb")?.getBoundingClientRect();
  if (!orbBox || rootBox.width <= 0 || rootBox.height <= 0) return null;

  const orbX = orbBox.left + orbBox.width / 2 - rootBox.left;
  const orbStartY = orbBox.top + orbBox.height * 0.8 - rootBox.top;
  const laneGeometry = laneElements
    .map(([laneId, laneElement, laneStatus]) => {
      if (!laneElement) return null;
      const headingElement = laneElement.querySelector(".phase-heading");
      if (!headingElement) return null;
      const headingBox = headingElement.getBoundingClientRect();
      const nodes = nodeElements
        .filter((entry) => entry.laneId === laneId && entry.element)
        .map((entry) => {
          const box = (entry.element.querySelector(".agent-node-summary") || entry.element).getBoundingClientRect();
          return {
            x: box.left - rootBox.left,
            y: box.top + box.height / 2 - rootBox.top,
            status: normalizeStatus(entry.status)
          };
        });
      return {
        id: laneId,
        status: normalizeStatus(laneStatus),
        headingX: headingBox.left - rootBox.left,
        headingY: headingBox.top + headingBox.height / 2 - rootBox.top,
        headingBottomY: headingBox.bottom - rootBox.top,
        nodes
      };
    })
    .filter(Boolean);

  if (laneGeometry.length === 0) return null;

  const leftAnchors = laneGeometry.flatMap((lane) => [lane.headingX, ...lane.nodes.map((node) => node.x)]);
  const railX = Math.max(18, Math.min(...leftAnchors) - 44);
  const routeY = orbStartY + 104;
  const railBottomY = Math.max(...laneGeometry.map((lane) => lane.headingY));
  const rootStatus = normalizeStatus(status);
  const rootAnimated = rootStatus === "running";
  const paths = [
    connectorPath(`M ${orbX} ${orbStartY} L ${orbX} ${routeY} L ${railX} ${routeY}`, rootStatus, rootAnimated),
    connectorPath(`M ${railX} ${routeY} L ${railX} ${railBottomY}`, rootStatus, rootAnimated)
  ];
  const circles = [circleAt(railX, routeY, 11, rootStatus)];

  laneGeometry.forEach((lane) => {
    const nodeLeftX = lane.nodes.length ? Math.min(...lane.nodes.map((node) => node.x)) : lane.headingX + 48;
    const groupRailX = Math.max(lane.headingX + 24, nodeLeftX - 44);
    const groupRailStartY = lane.headingBottomY;
    const laneAnimated = lane.status === "running";
    paths.push(connectorPath(`M ${railX} ${lane.headingY} L ${lane.headingX} ${lane.headingY}`, lane.status, laneAnimated));
    if (lane.nodes.length > 0) {
      const groupRailBottomY = Math.max(...lane.nodes.map((node) => node.y));
      paths.push(connectorPath(`M ${groupRailX} ${groupRailStartY} L ${groupRailX} ${groupRailBottomY}`, lane.status, laneAnimated));
    }
    lane.nodes.forEach((node) => {
      paths.push(connectorPath(`M ${groupRailX} ${node.y} L ${node.x} ${node.y}`, node.status, node.status === "running"));
      circles.push(circleAt(groupRailX, node.y, 9, node.status));
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
    h(
      "defs",
      null,
      h(
        "linearGradient",
        { id: "connector-rainbow", gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: connectors.width, y2: 0 },
        h("stop", { offset: "0%", stopColor: "#ff5a50" }),
        h("stop", { offset: "22%", stopColor: "#f5b83f" }),
        h("stop", { offset: "44%", stopColor: "#8bcf62" }),
        h("stop", { offset: "66%", stopColor: "#60a5fa" }),
        h("stop", { offset: "84%", stopColor: "#c084fc" }),
        h("stop", { offset: "100%", stopColor: "#ff5a50" })
      )
    ),
    connectors.paths.map((path, index) =>
      h("path", {
        key: `path-${index}`,
        className: `connector-line status-${path.status}${path.animated ? " connector-animated" : ""}`,
        d: path.d
      })
    ),
    connectors.circles.map((circle, index) =>
      h("circle", { key: `circle-${index}`, className: `connector-dot status-${circle.status}`, cx: circle.x, cy: circle.y, r: circle.size / 2 })
    )
  );
}

export function WorkflowGraph({ record, graph, selectedId, onSelect }) {
  const groups = graph.phases.length ? graph.phases : [{ id: "Workflow", label: "Workflow", nodes: [] }];
  const status = graphStatus(record, groups);
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
      const lanes = groups.map((group) => [group.id, laneRefs.current.get(group.id), aggregateStatus(group.nodes)]).filter(([, element]) => element);
      const nodes = groups.flatMap((group) =>
        group.nodes.map((node) => ({
          laneId: group.id,
          element: nodeRefs.current.get(node.id),
          status: node.status
        }))
      );
      setConnectors(measuredConnectors(rootRef.current, lanes, nodes, status));
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
  }, [layoutKey, status]);

  return h(
    "section",
    { className: `workflow-graph status-${status}`, ref: rootRef, "aria-label": "Workflow execution tree" },
    h(OrbScene, { record, graph }),
    h(ConnectorLayer, { connectors }),
    h(
      "div",
      { className: "phase-grid" },
      groups.map((group) => {
        const groupStatus = aggregateStatus(group.nodes);
        return h(
          "section",
          { className: "phase-lane", key: group.id, ref: (element) => setLaneRef(group.id, element) },
          h(
            "header",
            { className: `phase-heading status-${groupStatus}` },
            h("span", { className: `phase-icon status-${groupStatus}` }, iconForGroupStatus(groupStatus)),
            h("strong", null, group.label),
            h("span", null, `${group.nodes.length} agents`)
          ),
          h(
            "div",
            { className: "node-stack" },
            group.nodes.length
              ? group.nodes.map((node) =>
                  h(AgentNode, {
                    key: node.id,
                    node,
                    code: agentDisplayCode(node),
                    selected: node.id === selectedId,
                    onSelect,
                    setNodeRef
                  })
                )
              : h("p", { className: "empty-lane" }, "No workers in this group.")
          )
        );
      })
    )
  );
}
