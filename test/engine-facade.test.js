"use strict";

const test = require("node:test");
const assert = require("node:assert");

const engine = require("../scripts/ultracode-engine.js");

test("engine facade preserves the established public and test helper exports", () => {
  assert.deepStrictEqual(Object.keys(engine).sort(), [
    "DEFAULT_MAX_AGENTS",
    "DEFAULT_MODEL",
    "DEFAULT_REASONING_EFFORT",
    "GPT_5_6_MODELS",
    "GPT_5_6_REASONING_EFFORTS",
    "MAX_WORKERS",
    "VERDICT_SCHEMA",
    "WORKER_ROLES",
    "WORKER_SCHEMA",
    "_internal",
    "adversarialVerify",
    "buildCodexArgs",
    "buildResumeArgs",
    "compactWorkflow",
    "createContext",
    "createLimiter",
    "defaultConcurrency",
    "log",
    "loopUntilDry",
    "normalizeSpec",
    "planWorkflow",
    "readWorkflow",
    "resumeWorkflow",
    "runDagOnCtx",
    "runParallel",
    "runPipeline",
    "runPipelineSpec",
    "runScript",
    "runWorkflow",
    "selectRoles",
    "spawnWarmWorker",
    "spawnWorker",
    "stateDir",
    "statePathFor",
    "sumUsageFromWorkers",
    "validateAgainstSchema",
    "workerPrompt",
    "workerRecordFromResult",
    "workflowIdentity"
  ]);

  assert.deepStrictEqual(Object.keys(engine._internal).sort(), [
    "abortableDelay",
    "backoffDelay",
    "classifyCodexError",
    "compileSteps",
    "controllerSnapshot",
    "getPath",
    "injectSchemaIntoPrompt",
    "isResumeUnavailable",
    "normalizeAppServerUsage",
    "reconcileRunningRecord",
    "refreshControllerHeartbeat",
    "renderTemplate",
    "resolveModel",
    "resolveReasoningEffort",
    "resolveRetryInput",
    "resolveTransport",
    "resolveWorkerOpts",
    "spawnWorkerGuarded",
    "transportJournal"
  ]);
});
