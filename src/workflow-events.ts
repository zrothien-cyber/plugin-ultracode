"use strict";

function terminalWorkflowEvent(workflow) {
  const workers = Array.isArray(workflow && workflow.workers) ? workflow.workers : [];
  const counts = workers.reduce(
    (acc, worker) => {
      const status = worker && typeof worker.status === "string" ? worker.status : "pending";
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    },
    { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 }
  );
  const status = workflow && typeof workflow.status === "string" ? workflow.status : "failed";
  return {
    type: `workflow.${status}`,
    id: workflow && workflow.id,
    label: (workflow && (workflow.name || workflow.task || workflow.id)) || "workflow",
    status,
    message: `Workflow ${status}.`,
    data: {
      workflow_id: workflow && workflow.id,
      completed_at: workflow && workflow.completed_at,
      duration_ms: workflow && workflow.duration_ms,
      workers: workers.length,
      completed: counts.completed,
      failed: counts.failed,
      cancelled: counts.cancelled
    }
  };
}

module.exports = { terminalWorkflowEvent };
