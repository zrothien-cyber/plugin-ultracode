"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.USAGE_KEYS = void 0;
exports.defaultConcurrency = defaultConcurrency;
exports.normalizeConcurrency = normalizeConcurrency;
exports.createLimiter = createLimiter;
exports.emitEvent = emitEvent;
exports.log = log;
exports.emptyUsage = emptyUsage;
exports.addUsageInto = addUsageInto;
exports.accountUsage = accountUsage;
exports.sumUsageFromWorkers = sumUsageFromWorkers;
exports.createContext = createContext;
exports.validateAgainstSchema = validateAgainstSchema;
exports.stableStringify = stableStringify;
exports.stepId = stepId;
const crypto = __importStar(require("crypto"));
const os = __importStar(require("os"));
exports.USAGE_KEYS = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens"
];
function isObject(value) {
    return value !== null && typeof value === "object";
}
function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null)
            return value;
    }
    return undefined;
}
function clampNonNegativeInteger(value, fallback) {
    if (value === undefined || value === null || value === "")
        return fallback;
    const number = Number(value);
    if (!Number.isFinite(number))
        return fallback;
    return Math.max(0, Math.floor(number));
}
function asAbortSignal(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function"))
        return null;
    const candidate = value;
    return typeof candidate.addEventListener === "function" ? value : null;
}
function defaultConcurrency() {
    let cpus = 1;
    try {
        cpus = os.cpus().length || 1;
    }
    catch {
        cpus = 1;
    }
    return Math.max(1, Math.min(16, cpus - 2));
}
function normalizeConcurrency(value) {
    if (value === undefined || value === null || value === "")
        return defaultConcurrency();
    return Math.max(1, Math.min(16, Math.floor(Number(value)) || 1));
}
function createLimiter(maxConcurrent) {
    const max = Math.max(1, Math.floor(Number(maxConcurrent)) || 1);
    let active = 0;
    const queue = [];
    function drain() {
        while (active < max && queue.length > 0) {
            const next = queue.shift();
            if (!next)
                continue;
            active += 1;
            Promise.resolve()
                .then(next.thunk)
                .then((value) => {
                active -= 1;
                next.resolve(value);
                drain();
            }, (error) => {
                active -= 1;
                next.reject(error);
                drain();
            });
        }
    }
    return {
        run(thunk) {
            return new Promise((resolve, reject) => {
                queue.push({
                    thunk: () => thunk(),
                    resolve: (value) => resolve(value),
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
function emitEvent(ctx, event) {
    if (!ctx)
        return;
    const stamped = { at: new Date().toISOString(), ...event };
    ctx.events.push(stamped);
    if (ctx.onEvent) {
        try {
            ctx.onEvent(stamped);
        }
        catch {
            // Progress sinks must never break a run.
        }
    }
}
function log(ctx, message, data) {
    emitEvent(ctx, { type: "log", message, ...(data ? { data } : {}) });
}
function emptyUsage() {
    return {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0
    };
}
function addUsageInto(totals, usage) {
    if (!usage || typeof usage !== "object")
        return;
    const usageRecord = usage;
    for (const key of exports.USAGE_KEYS) {
        const value = usageRecord[key];
        if (typeof value === "number" && Number.isFinite(value))
            totals[key] += value;
    }
    totals.total_tokens = totals.input_tokens + totals.output_tokens + totals.reasoning_output_tokens;
}
function accountUsage(ctx, usage) {
    if (!ctx)
        return;
    addUsageInto(ctx.usageTotals, usage);
}
function sumUsageFromWorkers(workers) {
    const totals = emptyUsage();
    const list = workers || [];
    for (const worker of list) {
        const usage = isObject(worker) ? worker.usage : undefined;
        addUsageInto(totals, usage);
    }
    return totals;
}
function createContext(opts = {}, defaults) {
    const concurrency = normalizeConcurrency(opts.concurrency);
    const usageTotals = emptyUsage();
    const budgetTotal = opts.budgetTokens === undefined || opts.budgetTokens === null || opts.budgetTokens === ""
        ? null
        : Math.max(0, Math.floor(Number(opts.budgetTokens)));
    const launchStaggerMs = clampNonNegativeInteger(firstDefined(opts.launchStaggerMs, opts.launch_stagger_ms, process.env.ULTRACODE_LAUNCH_STAGGER_MS), defaults.defaultLaunchStaggerMs);
    const controller = new AbortController();
    const externalSignal = asAbortSignal(opts.signal);
    const depth = typeof opts.depth === "number" && Number.isFinite(opts.depth) ? opts.depth : 0;
    const maxDepth = typeof opts.maxDepth === "number" && Number.isFinite(opts.maxDepth) ? opts.maxDepth : defaults.maxNestingDepth;
    const ctx = {
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
        onEvent: typeof opts.onEvent === "function" ? opts.onEvent : null,
        onWorkerPending: typeof opts.onWorkerPending === "function" ? opts.onWorkerPending : null,
        onWorkerRecord: typeof opts.onWorkerRecord === "function" ? opts.onWorkerRecord : null,
        nextWorkerIndex: 0,
        signal: controller.signal,
        budget: {
            total: budgetTotal,
            spent: () => usageTotals.total_tokens,
            remaining: () => (budgetTotal === null ? Infinity : Math.max(0, budgetTotal - usageTotals.total_tokens))
        },
        cancelled: () => controller.signal.aborted,
        cancel: () => { }
    };
    ctx.cancel = (reason) => {
        if (controller.signal.aborted)
            return;
        controller.abort(reason === undefined ? "cancelled" : reason);
        emitEvent(ctx, {
            type: "cancelled",
            reason: typeof reason === "string" ? reason : "cancelled"
        });
    };
    if (externalSignal) {
        if (externalSignal.aborted) {
            ctx.cancel(typeof externalSignal.reason === "string" ? externalSignal.reason : "cancelled");
        }
        else {
            externalSignal.addEventListener("abort", () => {
                ctx.cancel(typeof externalSignal.reason === "string" ? externalSignal.reason : "cancelled");
            }, { once: true });
        }
    }
    return ctx;
}
function validateAgainstSchema(value, schema) {
    const errors = [];
    function check(candidate, candidateSchema, path) {
        if (!isObject(candidateSchema))
            return;
        const type = typeof candidateSchema.type === "string" ? candidateSchema.type : null;
        if (type) {
            const ok = type === "object"
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
        const isObjectShape = Boolean(type === "object" ||
            candidateSchema.properties ||
            candidateSchema.required ||
            candidateSchema.additionalProperties !== undefined);
        if (isObjectShape && candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
            const objectCandidate = candidate;
            const properties = isObject(candidateSchema.properties) ? candidateSchema.properties : {};
            const required = Array.isArray(candidateSchema.required) ? candidateSchema.required : [];
            for (const requiredKey of required) {
                const key = String(requiredKey);
                if (!(key in objectCandidate))
                    errors.push(`${path ? `${path}.` : ""}${key}: required`);
            }
            if (candidateSchema.additionalProperties === false) {
                for (const key of Object.keys(objectCandidate)) {
                    if (!(key in properties))
                        errors.push(`${path ? `${path}.` : ""}${key}: unexpected property`);
                }
            }
            for (const [key, subSchema] of Object.entries(properties)) {
                if (key in objectCandidate)
                    check(objectCandidate[key], subSchema, `${path ? `${path}.` : ""}${key}`);
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
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const objectValue = value;
    return `{${Object.keys(objectValue)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`)
        .join(",")}}`;
}
function stepId(parts) {
    return crypto.createHash("sha1").update(stableStringify(parts)).digest("hex").slice(0, 12);
}
