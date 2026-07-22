#!/usr/bin/env node
"use strict";

// Compatibility facade: public callers continue to load this path while the
// implementation is separated by responsibility.
const { workflowIdentity } = require("./run-identity");
const {
  controllerSnapshot,
  refreshControllerHeartbeat,
  reconcileRunningRecord
} = require("./run-lifecycle");
const createFoundation = require("./engine-foundation");
const createExecution = require("./engine-execution");
const createWorkflows = require("./engine-workflows");
const createPipeline = require("./engine-pipeline");

const foundation = createFoundation();
const execution = createExecution(foundation);
const workflows = createWorkflows(foundation, execution);
const pipeline = createPipeline(foundation, execution, workflows);

const {
  MAX_WORKERS,
  DEFAULT_MAX_AGENTS,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  GPT_5_6_MODELS,
  GPT_5_6_REASONING_EFFORTS,
  WORKER_SCHEMA,
  VERDICT_SCHEMA,
  WORKER_ROLES,
  planWorkflow,
  selectRoles,
  readWorkflow,
  stateDir,
  statePathFor,
  createContext,
  createLimiter,
  defaultConcurrency,
  validateAgainstSchema,
  sumUsageFromWorkers,
  log,
  classifyCodexError,
  backoffDelay,
  abortableDelay,
  resolveModel,
  resolveReasoningEffort,
  resolveTransport
} = foundation;
const {
  workerPrompt,
  buildCodexArgs,
  buildResumeArgs,
  isResumeUnavailable,
  injectSchemaIntoPrompt,
  normalizeAppServerUsage,
  resolveWorkerOpts,
  spawnWorker,
  spawnWorkerGuarded,
  spawnWarmWorker,
  runParallel,
  runPipeline,
  loopUntilDry,
  adversarialVerify
} = execution;
const {
  workerRecordFromResult,
  resolveRetryInput,
  transportJournal,
  compactWorkflow,
  normalizeSpec,
  runWorkflow,
  resumeWorkflow
} = workflows;
const { compileSteps, renderTemplate, getPath, runDagOnCtx, runPipelineSpec } = pipeline;

module.exports = {
  MAX_WORKERS,
  DEFAULT_MAX_AGENTS,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  GPT_5_6_MODELS,
  GPT_5_6_REASONING_EFFORTS,
  WORKER_SCHEMA,
  VERDICT_SCHEMA,
  planWorkflow,
  runWorkflow,
  runPipelineSpec,
  runDagOnCtx,
  resumeWorkflow,
  workerRecordFromResult,
  WORKER_ROLES,
  selectRoles,
  workerPrompt,
  normalizeSpec,
  // Keep this lazy: the script runner top-level-requires this facade.
  runScript: (...args) => require("./ultracode-script-runner").runScript(...args),
  readWorkflow,
  compactWorkflow,
  stateDir,
  statePathFor,
  workflowIdentity,
  spawnWorker,
  spawnWarmWorker,
  runParallel,
  runPipeline,
  loopUntilDry,
  adversarialVerify,
  createContext,
  createLimiter,
  defaultConcurrency,
  validateAgainstSchema,
  sumUsageFromWorkers,
  log,
  buildCodexArgs,
  buildResumeArgs,
  _internal: {
    compileSteps,
    renderTemplate,
    getPath,
    classifyCodexError,
    backoffDelay,
    abortableDelay,
    spawnWorkerGuarded,
    resolveWorkerOpts,
    resolveRetryInput,
    isResumeUnavailable,
    injectSchemaIntoPrompt,
    resolveTransport,
    normalizeAppServerUsage,
    transportJournal,
    resolveModel,
    resolveReasoningEffort,
    controllerSnapshot,
    refreshControllerHeartbeat,
    reconcileRunningRecord
  }
};
