export function workflowIdFromLocation() {
  const match = /^\/workflow\/([^/?#]+)/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function fetchJson(pathname) {
  const response = await fetch(pathname, { cache: "no-store" });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload && payload.error) message = payload.error;
    } catch {
      /* keep the HTTP status */
    }
    throw new Error(message);
  }
  return response.json();
}

export function compactText(value, limit = 280) {
  if (value === undefined || value === null) return "";
  let text;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "object" && typeof value.summary === "string") {
    text = value.summary;
  } else {
    text = JSON.stringify(value, null, 2);
  }
  text = String(text).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
}

export function fullText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof value.summary === "string" && Object.keys(value).length === 1) return value.summary;
  return JSON.stringify(value, null, 2);
}

export function outputText(worker) {
  if (!worker) return "";
  if (worker.error) return worker.error;
  if (worker.result !== undefined && worker.result !== null) return compactText(worker.result, 900);
  if (worker.value !== undefined && worker.value !== null) return compactText(worker.value, 900);
  return "";
}

export function fullOutputText(worker) {
  if (!worker) return "";
  if (worker.error) return worker.error;
  if (worker.result !== undefined && worker.result !== null) return fullText(worker.result);
  if (worker.value !== undefined && worker.value !== null) return fullText(worker.value);
  return "";
}

export function lastMessageFor(worker, events) {
  if (!worker) return "";
  const keys = new Set([worker.id, worker.step_id, worker.label, worker.title].filter(Boolean));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    const data = event.data || {};
    const matches =
      keys.has(event.id) ||
      keys.has(event.step_id) ||
      keys.has(event.label) ||
      keys.has(data.id) ||
      keys.has(data.step_id) ||
      keys.has(data.label);
    if (matches) {
      return event.message || event.type || "";
    }
  }
  return outputText(worker) || worker.status || "";
}

function eventMatchesWorker(event, worker) {
  if (!event || !worker) return false;
  const data = event.data || {};
  const keys = new Set([worker.id, worker.step_id, worker.label, worker.title].filter(Boolean));
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

function liveStatusFor(worker, events) {
  let status = worker.status || "pending";
  for (const event of events) {
    if (!eventMatchesWorker(event, worker)) continue;
    if (event.type === "worker.started" || event.type === "step.started" || event.type === "turn.completed") {
      if (status === "pending") status = "running";
    } else if (event.type === "worker.completed" || event.type === "step.completed") {
      status = event.status || "completed";
    } else if (event.type === "worker.failed") {
      status = "failed";
    } else if (event.type === "worker.cancelled") {
      status = "cancelled";
    }
  }
  return status;
}

export function normalizeWorkflow(record) {
  const events = Array.isArray(record && record.events) ? record.events : [];
  const primary = Array.isArray(record && record.steps) && record.steps.length > 0 ? record.steps : record.workers;
  const workers = Array.isArray(primary) ? primary : [];
  const nodes = workers.map((worker, index) => {
    const id = worker.id || worker.step_id || `worker-${index + 1}`;
    const kind = worker.kind || (worker.spec && worker.spec.kind) || (record.kind === "script" ? "agent" : "worker");
    return {
      ...worker,
      index,
      id,
      step_id: worker.step_id || id,
      label: worker.label || worker.title || id,
      title: worker.title || worker.label || id,
      kind,
      phase: worker.phase || "Workflow",
      status: liveStatusFor({ ...worker, index, id, step_id: worker.step_id || id }, events),
      last_message: lastMessageFor(worker, events)
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    if (node.step_id) nodeById.set(node.step_id, node);
  }
  const counts = nodes.reduce(
    (acc, node) => {
      acc[node.status] = (acc[node.status] || 0) + 1;
      return acc;
    },
    { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  );
  const phases = [];
  const phaseMap = new Map();
  for (const node of nodes) {
    const key = node.phase || "Workflow";
    if (!phaseMap.has(key)) {
      const group = { id: key, label: key, nodes: [] };
      phaseMap.set(key, group);
      phases.push(group);
    }
    phaseMap.get(key).nodes.push(node);
  }
  const links = [];
  for (const node of nodes) {
    const deps = Array.isArray(node.depends_on) ? node.depends_on : [];
    if (deps.length === 0) {
      links.push({ from: "__workflow__", to: node.id, kind: "root" });
    } else {
      for (const dep of deps) {
        const resolved = nodeById.get(dep);
        if (resolved) links.push({ from: resolved.id, to: node.id, kind: "dependency" });
      }
    }
  }
  return { events, nodes, counts, phases, links };
}

export function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function totalTokens(record) {
  const usage = record && record.aggregate_usage;
  return usage && Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0;
}
