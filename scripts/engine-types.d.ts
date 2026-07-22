import type { EventRecord, RunContext, ValidationResult } from "../src/engine-core";

type DynamicValue = ReturnType<typeof JSON.parse>;
export type UnknownFunction = (...args: DynamicValue[]) => DynamicValue;

export interface CodexExecResult {
  pid?: number | null;
  startup_timed_out?: boolean;
  timed_out?: boolean;
  stderr?: string;
  stdout?: string;
  exit_code?: number | null;
  signal?: string | null;
  cancelled?: boolean;
  duration_ms?: number;
  thread_id?: string | null;
  received_output?: boolean;
  usage?: unknown;
}

export interface CodexErrorClassification {
  transient: boolean;
  reason: string;
  defaultMaxRetries?: number;
}

export interface EngineError extends Error {
  code?: string;
  cancelled?: boolean;
  codex_exec?: CodexExecResult;
}

export interface Foundation {
  MAX_WORKERS: number;
  DEFAULT_WORKERS: number;
  DEFAULT_TIMEOUT_MS: number;
  DEFAULT_MAX_AGENTS: number;
  MAX_NESTING_DEPTH: number;
  DEFAULT_LAUNCH_STAGGER_MS: number;
  DEFAULT_GLOBAL_CONCURRENCY: number;
  DEFAULT_MODEL: string;
  DEFAULT_REASONING_EFFORT: string;
  GPT_5_6_MODELS: readonly string[];
  GPT_5_6_REASONING_EFFORTS: readonly string[];
  VALID_SANDBOXES: ReadonlySet<unknown>;
  VALID_EFFORTS: ReadonlySet<unknown>;
  VALID_TRANSPORTS: ReadonlySet<unknown>;
  WORKER_ROLES: unknown[];
  WORKER_SCHEMA: Record<string, unknown>;
  VERDICT_SCHEMA: Record<string, unknown>;
  codexHome(): string;
  isExecutable: UnknownFunction;
  defaultCodexBin(): string;
  stateDir: UnknownFunction;
  statePathFor: UnknownFunction;
  stepId: UnknownFunction;
  assertNonEmptyString: UnknownFunction;
  positiveInteger: UnknownFunction;
  resolveModel(value: unknown): string;
  resolveReasoningEffort(value: unknown): unknown;
  normalizeOptions: UnknownFunction;
  selectRoles: UnknownFunction;
  planWorkflow: UnknownFunction;
  writeJson: UnknownFunction;
  readJson: UnknownFunction;
  latestStatePath: UnknownFunction;
  readWorkflow: UnknownFunction;
  defaultConcurrency: UnknownFunction;
  normalizeConcurrency: UnknownFunction;
  normalizeGlobalConcurrency(value: unknown): number;
  createLimiter: UnknownFunction;
  emitEvent(ctx: RunContext | null | undefined, event: EventRecord): void;
  log(ctx: RunContext | null | undefined, message: string, data?: unknown): void;
  USAGE_KEYS: readonly string[];
  emptyUsage: UnknownFunction;
  addUsageInto: UnknownFunction;
  accountUsage(ctx: RunContext | null | undefined, usage: unknown): void;
  sumUsageFromWorkers: UnknownFunction;
  createContext: UnknownFunction;
  validateAgainstSchema(value: unknown, schema: unknown): ValidationResult;
  stableStringify: UnknownFunction;
  classifyCodexError(
    error: EngineError | null | undefined,
    execResult?: CodexExecResult | null
  ): CodexErrorClassification;
  backoffDelay(attempt: number, base: unknown, max: unknown, jitter: unknown): number;
  abortableDelay(ms: unknown, signal?: AbortSignal | null): Promise<void>;
  abortError(signal?: AbortSignal | null): EngineError;
  reserveLaunchStagger: UnknownFunction;
  waitForLaunchStagger(ctx: RunContext | null | undefined, label: unknown, phase: unknown): Promise<void>;
  firstDefined(...values: unknown[]): unknown;
  clampNonNegInt(value: unknown, fallback: number): number;
  resolveBool(value: unknown, fallback: boolean): boolean;
  resolveTransport(value: unknown): string;
}

export interface Execution {
  workerPrompt: UnknownFunction;
  buildCodexArgs: UnknownFunction;
  buildResumeArgs: UnknownFunction;
  isResumeUnavailable: UnknownFunction;
  injectSchemaIntoPrompt: UnknownFunction;
  normalizeAppServerUsage: UnknownFunction;
  resolveWorkerOpts: UnknownFunction;
  spawnWorker: UnknownFunction;
  spawnWorkerGuarded: UnknownFunction;
  spawnWarmWorker: UnknownFunction;
  runParallel: UnknownFunction;
  runPipeline: UnknownFunction;
  loopUntilDry: UnknownFunction;
  adversarialVerify: UnknownFunction;
}

export interface Workflows {
  workerRecordFromResult: UnknownFunction;
  resolveRetryInput: UnknownFunction;
  transportJournal: UnknownFunction;
  compactWorkflow: UnknownFunction;
  makePersister: UnknownFunction;
  attachLiveJournalPersistence: UnknownFunction;
  finalizeRecord: UnknownFunction;
  normalizeSpec: UnknownFunction;
  runWorkflow: UnknownFunction;
  resumeWorkflow: UnknownFunction;
}

export interface Pipeline {
  compileSteps: UnknownFunction;
  renderTemplate: UnknownFunction;
  getPath: UnknownFunction;
  runDagOnCtx: UnknownFunction;
  runPipelineSpec: UnknownFunction;
}
