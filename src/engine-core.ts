import * as crypto from "crypto";
import * as os from "os";

export const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens"
] as const;

export type UsageKey = (typeof USAGE_KEYS)[number];

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export type EventRecord = Record<string, unknown>;
export type EventHandler = (event: EventRecord) => unknown;
export type WorkerHook = (...args: unknown[]) => unknown;

export interface Limiter {
  run<T>(thunk: () => T | PromiseLike<T>): Promise<T>;
  active(): number;
  queued(): number;
  max: number;
}

export interface ContextOptions {
  workflowId?: unknown;
  concurrency?: unknown;
  budgetTokens?: unknown;
  maxAgents?: unknown;
  launchStaggerMs?: unknown;
  launch_stagger_ms?: unknown;
  depth?: unknown;
  maxDepth?: unknown;
  onEvent?: unknown;
  onWorkerPending?: unknown;
  onWorkerRecord?: unknown;
  signal?: unknown;
}

export interface ContextDefaults {
  defaultMaxAgents: number;
  maxNestingDepth: number;
  defaultLaunchStaggerMs: number;
}

export interface RunContext {
  workflowId: unknown;
  limiter: Limiter;
  concurrency: number;
  usageTotals: Usage;
  events: EventRecord[];
  spawnedCount: number;
  maxAgents: number;
  launchStaggerMs: number;
  nextLaunchAt: number;
  depth: number;
  maxDepth: number;
  onEvent: EventHandler | null;
  onWorkerPending: WorkerHook | null;
  onWorkerRecord: WorkerHook | null;
  nextWorkerIndex: number;
  signal: AbortSignal;
  budget: {
    total: number | null;
    spent(): number;
    remaining(): number;
  };
  cancelled(): boolean;
  cancel(reason?: unknown): void;
}

export interface JsonSchema {
  type?: unknown;
  enum?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  [keyword: string]: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

interface QueuedTask {
  thunk: () => unknown | PromiseLike<unknown>;
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function clampNonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.floor(number));
}

function asAbortSignal(value: unknown): AbortSignal | null {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  const candidate = value as { addEventListener?: unknown };
  return typeof candidate.addEventListener === "function" ? (value as AbortSignal) : null;
}

export function defaultConcurrency(): number {
  let cpus = 1;
  try {
    cpus = os.cpus().length || 1;
  } catch {
    cpus = 1;
  }
  return Math.max(1, Math.min(16, cpus - 2));
}

export function normalizeConcurrency(value: unknown): number {
  if (value === undefined || value === null || value === "") return defaultConcurrency();
  return Math.max(1, Math.min(16, Math.floor(Number(value)) || 1));
}

export function createLimiter(maxConcurrent: unknown): Limiter {
  const max = Math.max(1, Math.floor(Number(maxConcurrent)) || 1);
  let active = 0;
  const queue: QueuedTask[] = [];

  function drain(): void {
    while (active < max && queue.length > 0) {
      const next = queue.shift();
      if (!next) continue;
      active += 1;
      Promise.resolve()
        .then(next.thunk)
        .then(
          (value) => {
            active -= 1;
            next.resolve(value);
            drain();
          },
          (error: unknown) => {
            active -= 1;
            next.reject(error);
            drain();
          }
        );
    }
  }

  return {
    run<T>(thunk: () => T | PromiseLike<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          thunk: () => thunk(),
          resolve: (value) => resolve(value as T),
          reject
        });
        drain();
      });
    },
    active: () => active,
    queued: () => queue.length,
    max
  };
}

export function emitEvent(ctx: RunContext | null | undefined, event: EventRecord): void {
  if (!ctx) return;
  const stamped = { at: new Date().toISOString(), ...event };
  ctx.events.push(stamped);
  if (ctx.onEvent) {
    try {
      ctx.onEvent(stamped);
    } catch {
      // Progress sinks must never break a run.
    }
  }
}

export function log(ctx: RunContext | null | undefined, message: string, data?: unknown): void {
  emitEvent(ctx, { type: "log", message, ...(data ? { data } : {}) });
}

export function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

export function addUsageInto(totals: Usage, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const usageRecord = usage as Record<string, unknown>;
  for (const key of USAGE_KEYS) {
    const value = usageRecord[key];
    if (typeof value === "number" && Number.isFinite(value)) totals[key] += value;
  }
  totals.total_tokens = totals.input_tokens + totals.output_tokens + totals.reasoning_output_tokens;
}

export function accountUsage(ctx: RunContext | null | undefined, usage: unknown): void {
  if (!ctx) return;
  addUsageInto(ctx.usageTotals, usage);
}

export function sumUsageFromWorkers(workers: unknown): Usage {
  const totals = emptyUsage();
  const list = workers || [];
  for (const worker of list as Iterable<unknown>) {
    const usage = isObject(worker) ? worker.usage : undefined;
    addUsageInto(totals, usage);
  }
  return totals;
}

export function createContext(opts: ContextOptions = {}, defaults: ContextDefaults): RunContext {
  const concurrency = normalizeConcurrency(opts.concurrency);
  const usageTotals = emptyUsage();
  const budgetTotal =
    opts.budgetTokens === undefined || opts.budgetTokens === null || opts.budgetTokens === ""
      ? null
      : Math.max(0, Math.floor(Number(opts.budgetTokens)));
  const launchStaggerMs = clampNonNegativeInteger(
    firstDefined(opts.launchStaggerMs, opts.launch_stagger_ms, process.env.ULTRACODE_LAUNCH_STAGGER_MS),
    defaults.defaultLaunchStaggerMs
  );
  const controller = new AbortController();
  const externalSignal = asAbortSignal(opts.signal);
  const depth = typeof opts.depth === "number" && Number.isFinite(opts.depth) ? opts.depth : 0;
  const maxDepth = typeof opts.maxDepth === "number" && Number.isFinite(opts.maxDepth) ? opts.maxDepth : defaults.maxNestingDepth;
  const ctx: RunContext = {
    workflowId: opts.workflowId || null,
    limiter: createLimiter(concurrency),
    concurrency,
    usageTotals,
    events: [],
    spawnedCount: 0,
    maxAgents: opts.maxAgents ? Math.max(1, Math.floor(Number(opts.maxAgents))) : defaults.defaultMaxAgents,
    launchStaggerMs,
    nextLaunchAt: 0,
    depth,
    maxDepth,
    onEvent: typeof opts.onEvent === "function" ? (opts.onEvent as EventHandler) : null,
    onWorkerPending: typeof opts.onWorkerPending === "function" ? (opts.onWorkerPending as WorkerHook) : null,
    onWorkerRecord: typeof opts.onWorkerRecord === "function" ? (opts.onWorkerRecord as WorkerHook) : null,
    nextWorkerIndex: 0,
    signal: controller.signal,
    budget: {
      total: budgetTotal,
      spent: () => usageTotals.total_tokens,
      remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - usageTotals.total_tokens))
    },
    cancelled: () => controller.signal.aborted,
    cancel: () => {}
  };

  ctx.cancel = (reason?: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(reason === undefined ? "cancelled" : reason);
    emitEvent(ctx, {
      type: "cancelled",
      reason: typeof reason === "string" ? reason : "cancelled"
    });
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      ctx.cancel(typeof externalSignal.reason === "string" ? externalSignal.reason : "cancelled");
    } else {
      externalSignal.addEventListener(
        "abort",
        () => {
          ctx.cancel(typeof externalSignal.reason === "string" ? externalSignal.reason : "cancelled");
        },
        { once: true }
      );
    }
  }
  return ctx;
}

export function validateAgainstSchema(value: unknown, schema: unknown): ValidationResult {
  const errors: string[] = [];

  function check(candidate: unknown, candidateSchema: unknown, path: string): void {
    if (!isObject(candidateSchema)) return;
    const type = typeof candidateSchema.type === "string" ? candidateSchema.type : null;
    if (type) {
      const ok =
        type === "object"
          ? candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
          : type === "array"
          ? Array.isArray(candidate)
          : type === "string"
          ? typeof candidate === "string"
          : type === "integer"
          ? Number.isInteger(candidate)
          : type === "number"
          ? typeof candidate === "number" && Number.isFinite(candidate)
          : type === "boolean"
          ? typeof candidate === "boolean"
          : type === "null"
          ? candidate === null
          : true;
      if (!ok) {
        errors.push(`${path || "(root)"}: expected ${type}`);
        return;
      }
    }

    if (Array.isArray(candidateSchema.enum) && !candidateSchema.enum.includes(candidate)) {
      errors.push(`${path || "(root)"}: must be one of ${JSON.stringify(candidateSchema.enum)}`);
    }

    const isObjectShape = Boolean(
      type === "object" ||
        candidateSchema.properties ||
        candidateSchema.required ||
        candidateSchema.additionalProperties !== undefined
    );
    if (isObjectShape && candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const objectCandidate = candidate as Record<string, unknown>;
      const properties = isObject(candidateSchema.properties) ? candidateSchema.properties : {};
      const required = Array.isArray(candidateSchema.required) ? candidateSchema.required : [];
      for (const requiredKey of required) {
        const key = String(requiredKey);
        if (!(key in objectCandidate)) errors.push(`${path ? `${path}.` : ""}${key}: required`);
      }
      if (candidateSchema.additionalProperties === false) {
        for (const key of Object.keys(objectCandidate)) {
          if (!(key in properties)) errors.push(`${path ? `${path}.` : ""}${key}: unexpected property`);
        }
      }
      for (const [key, subSchema] of Object.entries(properties)) {
        if (key in objectCandidate) check(objectCandidate[key], subSchema, `${path ? `${path}.` : ""}${key}`);
      }
    }

    const isArrayShape = Boolean(type === "array" || candidateSchema.items);
    if (isArrayShape && Array.isArray(candidate) && candidateSchema.items) {
      candidate.forEach((item, index) => check(item, candidateSchema.items, `${path}[${index}]`));
    }
  }

  check(value, schema, "");
  return { ok: errors.length === 0, errors };
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const objectValue = value as Record<string, unknown>;
  return `{${Object.keys(objectValue)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
    .join(",")}}`;
}

export function stepId(parts: unknown): string {
  return crypto.createHash("sha1").update(stableStringify(parts)).digest("hex").slice(0, 12);
}
