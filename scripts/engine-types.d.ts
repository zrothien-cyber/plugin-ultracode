export type AnyFunction = (...args: any[]) => any;

export interface EngineError extends Error {
  code?: string;
  cancelled?: boolean;
  codex_exec?: unknown;
}

export interface Foundation {
  MAX_WORKERS: number;
  DEFAULT_WORKERS: number;
  DEFAULT_TIMEOUT_MS: number;
  DEFAULT_MAX_AGENTS: number;
  MAX_NESTING_DEPTH: number;
  DEFAULT_LAUNCH_STAGGER_MS: number;
  DEFAULT_MODEL: string;
  DEFAULT_REASONING_EFFORT: string;
  GPT_5_6_MODELS: readonly string[];
  GPT_5_6_REASONING_EFFORTS: readonly string[];
  VALID_SANDBOXES: Set<string>;
  VALID_EFFORTS: Set<string>;
  VALID_TRANSPORTS: Set<string>;
  WORKER_ROLES: unknown[];
  WORKER_SCHEMA: Record<string, unknown>;
  VERDICT_SCHEMA: Record<string, unknown>;
  codexHome: AnyFunction;
  isExecutable: AnyFunction;
  defaultCodexBin: AnyFunction;
  stateDir: AnyFunction;
  statePathFor: AnyFunction;
  stepId: AnyFunction;
  assertNonEmptyString: AnyFunction;
  positiveInteger: AnyFunction;
  resolveModel: AnyFunction;
  resolveReasoningEffort: AnyFunction;
  normalizeOptions: AnyFunction;
  selectRoles: AnyFunction;
  planWorkflow: AnyFunction;
  writeJson: AnyFunction;
  readJson: AnyFunction;
  latestStatePath: AnyFunction;
  readWorkflow: AnyFunction;
  defaultConcurrency: AnyFunction;
  normalizeConcurrency: AnyFunction;
  createLimiter: AnyFunction;
  emitEvent: AnyFunction;
  log: AnyFunction;
  USAGE_KEYS: readonly string[];
  emptyUsage: AnyFunction;
  addUsageInto: AnyFunction;
  accountUsage: AnyFunction;
  sumUsageFromWorkers: AnyFunction;
  createContext: AnyFunction;
  validateAgainstSchema: AnyFunction;
  stableStringify: AnyFunction;
  classifyCodexError: AnyFunction;
  backoffDelay: AnyFunction;
  abortableDelay: AnyFunction;
  abortError: AnyFunction;
  reserveLaunchStagger: AnyFunction;
  waitForLaunchStagger: AnyFunction;
  firstDefined: AnyFunction;
  clampNonNegInt: AnyFunction;
  resolveBool: AnyFunction;
  resolveTransport: AnyFunction;
}

export interface Execution {
  workerPrompt: AnyFunction;
  buildCodexArgs: AnyFunction;
  buildResumeArgs: AnyFunction;
  isResumeUnavailable: AnyFunction;
  injectSchemaIntoPrompt: AnyFunction;
  normalizeAppServerUsage: AnyFunction;
  resolveWorkerOpts: AnyFunction;
  spawnWorker: AnyFunction;
  spawnWorkerGuarded: AnyFunction;
  spawnWarmWorker: AnyFunction;
  runParallel: AnyFunction;
  runPipeline: AnyFunction;
  loopUntilDry: AnyFunction;
  adversarialVerify: AnyFunction;
}

export interface Workflows {
  workerRecordFromResult: AnyFunction;
  resolveRetryInput: AnyFunction;
  transportJournal: AnyFunction;
  compactWorkflow: AnyFunction;
  makePersister: AnyFunction;
  attachLiveJournalPersistence: AnyFunction;
  finalizeRecord: AnyFunction;
  normalizeSpec: AnyFunction;
  runWorkflow: AnyFunction;
  resumeWorkflow: AnyFunction;
}

export interface Pipeline {
  compileSteps: AnyFunction;
  renderTemplate: AnyFunction;
  getPath: AnyFunction;
  runDagOnCtx: AnyFunction;
  runPipelineSpec: AnyFunction;
}
