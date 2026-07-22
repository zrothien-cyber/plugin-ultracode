"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const { workflowIdentity } = require("./run-identity");
const { controllerSnapshot, refreshControllerHeartbeat } = require("./run-lifecycle");
const { attachWorkflowUi, shouldLaunchUi } = require("./ultracode-ui-launcher");
const { terminalWorkflowEvent } = require("./workflow-events");
// Workflow journal construction, persistence, resume, and fixed-role execution.
/**
 * @param {import("./engine-types").Foundation} foundation
 * @param {import("./engine-types").Execution} execution
 * @returns {import("./engine-types").Workflows}
 */
module.exports = function createWorkflows(foundation, execution) {
    const { DEFAULT_TIMEOUT_MS, VALID_SANDBOXES, VALID_EFFORTS, WORKER_SCHEMA, assertNonEmptyString, resolveModel, resolveReasoningEffort, normalizeOptions, selectRoles, writeJson, readWorkflow, statePathFor, stepId, createContext, sumUsageFromWorkers, emitEvent, log, defaultCodexBin, codexHome, firstDefined, clampNonNegInt, resolveBool, resolveTransport } = foundation;
    const { workerPrompt, spawnWorker } = execution;
    function workerRecordFromResult(base, result) {
        if (result.status === "completed") {
            return {
                ...base,
                status: "completed",
                result: result.value,
                value: result.value,
                usage: result.usage,
                duration_ms: result.duration_ms,
                ...(result.schema_valid === false ? { schema_valid: false } : {}),
                ...(result.thread_id ? { thread_id: result.thread_id } : {}),
                ...(result.diff !== undefined ? { diff: result.diff } : {})
            };
        }
        if (result.status === "cancelled") {
            return {
                ...base,
                status: "cancelled",
                result: null,
                value: null,
                error: result.error || "cancelled"
            };
        }
        return {
            ...base,
            status: "failed",
            result: null,
            value: null,
            error: result.error,
            ...(result.codex_exec ? { codex_exec: result.codex_exec } : {})
        };
    }
    // Normalize the transient-retry knobs off a workflow-level input into both the
    // per-worker option bag (worker) and a journalable snapshot (journal). Defaults
    // reproduce the pre-retry behavior (maxRetries 0).
    function resolveRetryInput(input = {}) {
        const maxRetries = clampNonNegInt(firstDefined(input.max_retries, input.maxRetries), 0);
        const baseDelayMs = clampNonNegInt(firstDefined(input.base_delay_ms, input.baseDelayMs), 500);
        const maxDelayMs = clampNonNegInt(firstDefined(input.max_delay_ms, input.maxDelayMs), 30_000);
        const retryJitter = resolveBool(firstDefined(input.retry_jitter, input.retryJitter), true);
        return {
            worker: { maxRetries, baseDelayMs, maxDelayMs, retryJitter },
            // Only journal the retry knobs when retries are actually enabled, so a plain
            // run's options object stays byte-identical to the pre-retry shape.
            journal: maxRetries > 0
                ? { max_retries: maxRetries, base_delay_ms: baseDelayMs, max_delay_ms: maxDelayMs, retry_jitter: retryJitter }
                : {}
        };
    }
    // Journal the transport ONLY when it is non-default, so a plain run's options
    // object stays byte-identical to the pre-transport shape. transportStrict is
    // only journaled alongside a non-default transport.
    function transportJournal(transport, transportStrict) {
        if (!transport || transport === "exec")
            return {};
        return { transport, ...(transportStrict ? { transport_strict: true } : {}) };
    }
    async function runLegacyWorker(options, workflow, worker, ctx, retryWorker) {
        const prompt = workerPrompt({ task: options.task, workflow, worker, sandbox: options.sandbox });
        const result = await spawnWorker(prompt, {
            ctx,
            schema: WORKER_SCHEMA,
            sandbox: options.sandbox,
            model: options.model,
            reasoningEffort: options.reasoning_effort,
            timeoutMs: options.timeout_ms,
            cwd: options.cwd,
            codex_bin: options.codex_bin,
            codex_home: options.codex_home,
            transport: options.transport,
            transport_strict: options.transport_strict,
            label: worker.title,
            phase: worker.phase,
            ...(retryWorker || {})
        });
        return workerRecordFromResult(worker, result);
    }
    function compactWorkflow(workflow) {
        const completed = workflow.workers.filter((worker) => worker.status === "completed");
        const failed = workflow.workers.filter((worker) => worker.status === "failed");
        const labelOf = (worker) => worker.title || worker.label || worker.id;
        const collect = (field) => completed.flatMap((worker) => worker.result && typeof worker.result === "object" && Array.isArray(worker.result[field])
            ? worker.result[field].map((item) => `${labelOf(worker)}: ${item}`)
            : []);
        const summary = completed.map((worker) => {
            if (worker.result && typeof worker.result === "object" && typeof worker.result.summary === "string") {
                return `${labelOf(worker)}: ${worker.result.summary}`;
            }
            if (typeof worker.result === "string")
                return `${labelOf(worker)}: ${worker.result.slice(0, 500)}`;
            return `${labelOf(worker)}: (no summary)`;
        });
        return {
            summary,
            findings: collect("findings"),
            recommended_actions: collect("recommended_actions"),
            risks: collect("risks"),
            verification: collect("verification"),
            failed_workers: failed.map((worker) => `${labelOf(worker)}: ${worker.error}`),
            aggregate_usage: workflow.aggregate_usage || sumUsageFromWorkers(workflow.workers)
        };
    }
    function makePersister(record, ctx) {
        let chain = Promise.resolve();
        return {
            schedule() {
                // Snapshot the record at schedule time so each queued write captures the
                // progress as of when it was scheduled, rather than all writes racing to
                // serialize the same live (eventually final) object reference.
                refreshControllerHeartbeat(record);
                const snapshot = JSON.parse(JSON.stringify(record));
                chain = chain
                    .then(() => writeJson(record.state_path, snapshot))
                    .catch((error) => {
                    // Don't crash the run on a transient write error, but don't hide it.
                    log(ctx, `Failed to persist workflow state: ${error.message}`, { reason: "persist-error" });
                    process.stderr.write(`[ultracode] state persist error: ${error.message}\n`);
                });
                return chain;
            },
            flush() {
                return chain;
            }
        };
    }
    function statusFromLifecycleEvent(event) {
        if (!event || typeof event.type !== "string")
            return null;
        if (event.type === "worker.started" || event.type === "step.started" || event.type === "turn.completed")
            return "running";
        if (event.type === "worker.completed" || event.type === "step.completed")
            return event.status || "completed";
        if (event.type === "worker.failed")
            return "failed";
        if (event.type === "worker.cancelled")
            return "cancelled";
        return null;
    }
    function eventMatchesRecordItem(event, item, index) {
        if (!event || !item)
            return false;
        const data = event.data || {};
        const keys = new Set([item.id, item.step_id, item.label, item.title].filter(Boolean));
        return (event.worker_index === index ||
            data.worker_index === index ||
            keys.has(event.id) ||
            keys.has(event.step_id) ||
            keys.has(event.label) ||
            keys.has(data.id) ||
            keys.has(data.step_id) ||
            keys.has(data.label));
    }
    function applyLifecycleEventToRecord(record, event) {
        const nextStatus = statusFromLifecycleEvent(event);
        if (!nextStatus || !record || typeof record !== "object")
            return;
        const lists = [];
        if (Array.isArray(record.workers))
            lists.push(record.workers);
        if (Array.isArray(record.steps) && record.steps !== record.workers)
            lists.push(record.steps);
        for (const list of lists) {
            list.forEach((item, index) => {
                if (!eventMatchesRecordItem(event, item, index))
                    return;
                if (nextStatus === "running" && item.status !== "pending")
                    return;
                item.status = nextStatus;
            });
        }
    }
    function attachLiveJournalPersistence(record, ctx, persister) {
        if (!record || !ctx || !persister || !record.ui)
            return;
        const upstream = ctx.onEvent;
        ctx.onEvent = (event) => {
            applyLifecycleEventToRecord(record, event);
            persister.schedule();
            if (upstream)
                upstream(event);
        };
    }
    function finalizeRecord(workflow, ctx) {
        const completed = workflow.workers.filter((worker) => worker.status === "completed").length;
        const anyCancelled = workflow.workers.some((worker) => worker.status === "cancelled");
        const aborted = !!(ctx && ctx.signal && ctx.signal.aborted);
        if (aborted && anyCancelled) {
            // A deliberately-aborted run with at least one cancelled worker is reported
            // as 'cancelled' (distinct from a genuine failure). Additive: when nothing
            // is cancelled this branch is skipped and the math below is unchanged.
            workflow.status = "cancelled";
        }
        else {
            workflow.status = completed === workflow.workers.length ? "completed" : completed === 0 ? "failed" : "partial";
        }
        workflow.completed_at = new Date().toISOString();
        workflow.duration_ms = Date.parse(workflow.completed_at) - Date.parse(workflow.started_at);
        workflow.aggregate_usage = sumUsageFromWorkers(workflow.workers);
        workflow.events = ctx.events;
        workflow.aggregate = compactWorkflow(workflow);
        emitEvent(ctx, terminalWorkflowEvent(workflow));
    }
    function normalizeSpec(spec, index, defaults) {
        if (!spec || typeof spec !== "object") {
            throw new Error(`workers_spec[${index}] must be an object.`);
        }
        const prompt = assertNonEmptyString(spec.prompt, `workers_spec[${index}].prompt`);
        const label = typeof spec.label === "string" && spec.label.trim() ? spec.label.trim() : `worker-${index + 1}`;
        const sandbox = spec.sandbox || defaults.sandbox;
        if (!VALID_SANDBOXES.has(sandbox)) {
            throw new Error(`workers_spec[${index}].sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
        }
        const effort = spec.reasoning_effort || defaults.reasoning_effort;
        if (effort !== undefined && effort !== null && !VALID_EFFORTS.has(effort)) {
            throw new Error(`workers_spec[${index}].reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
        }
        const schema = spec.schema === null ? null : spec.schema && typeof spec.schema === "object" ? spec.schema : WORKER_SCHEMA;
        const cwd = spec.cwd ? path.resolve(spec.cwd) : defaults.cwd;
        return {
            index,
            id: stepId({ kind: "explicit", index, label, prompt, schema }),
            prompt,
            label,
            schema,
            phase: spec.phase || null,
            sandbox,
            model: typeof spec.model === "string" && spec.model.trim() ? spec.model.trim() : defaults.model,
            reasoning_effort: effort || undefined,
            timeout_ms: spec.timeout_ms ? Math.max(1_000, Math.floor(Number(spec.timeout_ms))) : defaults.timeout_ms,
            cwd,
            isolation: spec.isolation === "worktree" ? "worktree" : undefined
        };
    }
    async function runExplicitWorkflow(input) {
        const cwd = path.resolve(input.cwd || process.cwd());
        const baseSandbox = input.sandbox || "read-only";
        if (!VALID_SANDBOXES.has(baseSandbox)) {
            throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
        }
        const baseEffort = resolveReasoningEffort(input.reasoning_effort || input.reasoningEffort);
        if (baseEffort !== undefined && baseEffort !== null && !VALID_EFFORTS.has(baseEffort)) {
            throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
        }
        const timeoutMs = input.timeout_ms === undefined || input.timeout_ms === null
            ? DEFAULT_TIMEOUT_MS
            : Math.max(1_000, Math.floor(Number(input.timeout_ms)));
        const defaults = {
            cwd,
            sandbox: baseSandbox,
            model: resolveModel(input.model),
            reasoning_effort: baseEffort,
            timeout_ms: timeoutMs
        };
        const specs = input.workers_spec.map((spec, index) => normalizeSpec(spec, index, defaults));
        const retryOpts = resolveRetryInput(input);
        const identity = workflowIdentity({
            ...input,
            labels: specs.map((spec) => spec.label)
        }, "Explicit Workers");
        const id = identity.id;
        const ctx = createContext({
            workflowId: id,
            concurrency: input.concurrency,
            globalConcurrency: firstDefined(input.global_concurrency, input.globalConcurrency),
            budgetTokens: input.budget_tokens,
            maxAgents: input.max_agents,
            launchStaggerMs: input.launch_stagger_ms,
            depth: Number(process.env.ULTRACODE_DEPTH || 0),
            onEvent: typeof input.on_event === "function" ? input.on_event : null,
            signal: input.signal
        });
        const now = new Date().toISOString();
        const codexBin = typeof input.codex_bin === "string" && input.codex_bin.trim() ? input.codex_bin.trim() : defaultCodexBin();
        const codexHomeValue = typeof input.codex_home === "string" && input.codex_home.trim() ? input.codex_home.trim() : codexHome();
        const transport = resolveTransport(firstDefined(input.transport, process.env.ULTRACODE_TRANSPORT));
        const transportStrict = resolveBool(firstDefined(input.transport_strict, input.transportStrict), false);
        const workflow = {
            id,
            name: identity.name,
            slug: identity.slug,
            status: "running",
            task: input.task || `${specs.length} explicit workers`,
            cwd,
            started_at: now,
            completed_at: null,
            controller: controllerSnapshot(now),
            options: {
                workers: specs.length,
                sandbox: baseSandbox,
                timeout_ms: timeoutMs,
                model: defaults.model || null,
                reasoning_effort: baseEffort || null,
                concurrency: ctx.concurrency,
                global_concurrency: ctx.globalConcurrency,
                budget_tokens: ctx.budget.total,
                max_agents: ctx.maxAgents,
                launch_stagger_ms: ctx.launchStaggerMs,
                ui: shouldLaunchUi(input),
                explicit: true,
                ...retryOpts.journal,
                ...transportJournal(transport, transportStrict)
            },
            state_path: statePathFor(id),
            phases: Array.from(new Set(specs.map((spec) => spec.phase).filter(Boolean))),
            workers: specs.map((spec) => ({
                index: spec.index,
                id: spec.id,
                step_id: spec.id,
                title: spec.label,
                label: spec.label,
                phase: spec.phase,
                model: spec.model || null,
                reasoning_effort: spec.reasoning_effort || null,
                status: "pending",
                // Stored so the run can be resumed without the original call.
                spec: {
                    prompt: spec.prompt,
                    schema: spec.schema,
                    sandbox: spec.sandbox,
                    model: spec.model || null,
                    reasoning_effort: spec.reasoning_effort || null,
                    timeout_ms: spec.timeout_ms,
                    cwd: spec.cwd,
                    isolation: spec.isolation || null
                }
            })),
            events: ctx.events,
            aggregate_usage: ctx.usageTotals
        };
        await writeJson(workflow.state_path, workflow);
        const persister = makePersister(workflow, ctx);
        await attachWorkflowUi(workflow, ctx, input);
        if (workflow.ui) {
            persister.schedule();
            attachLiveJournalPersistence(workflow, ctx, persister);
        }
        const results = await Promise.all(specs.map((spec, i) => spawnWorker(spec.prompt, {
            ctx,
            schema: spec.schema,
            sandbox: spec.sandbox,
            model: spec.model,
            reasoningEffort: spec.reasoning_effort,
            timeoutMs: spec.timeout_ms,
            cwd: spec.cwd,
            codex_bin: codexBin,
            codex_home: codexHomeValue,
            transport,
            transport_strict: transportStrict,
            label: spec.label,
            phase: spec.phase,
            isolation: spec.isolation,
            ...retryOpts.worker
        }).then((result) => {
            const base = workflow.workers[i];
            workflow.workers[i] = workerRecordFromResult(base, result);
            persister.schedule();
            return workflow.workers[i];
        })));
        workflow.workers = results;
        finalizeRecord(workflow, ctx);
        persister.schedule();
        await persister.flush();
        return workflow;
    }
    async function runWorkflow(input = {}) {
        if (Array.isArray(input.workers_spec) && input.workers_spec.length > 0) {
            return runExplicitWorkflow(input);
        }
        const options = normalizeOptions(input);
        const retryOpts = resolveRetryInput(input);
        const identity = workflowIdentity(input, "Worker Plan");
        const id = identity.id;
        const ctx = createContext({
            workflowId: id,
            concurrency: input.concurrency,
            globalConcurrency: firstDefined(input.global_concurrency, input.globalConcurrency),
            budgetTokens: input.budget_tokens,
            maxAgents: input.max_agents,
            launchStaggerMs: input.launch_stagger_ms,
            depth: Number(process.env.ULTRACODE_DEPTH || 0),
            onEvent: typeof input.on_event === "function" ? input.on_event : null,
            signal: input.signal
        });
        const now = new Date().toISOString();
        const workflow = {
            id,
            name: identity.name,
            slug: identity.slug,
            status: "running",
            task: options.task,
            cwd: options.cwd,
            started_at: now,
            completed_at: null,
            controller: controllerSnapshot(now),
            options: {
                workers: options.workers,
                sandbox: options.sandbox,
                timeout_ms: options.timeout_ms,
                model: options.model || null,
                reasoning_effort: options.reasoning_effort || null,
                concurrency: ctx.concurrency,
                global_concurrency: ctx.globalConcurrency,
                budget_tokens: ctx.budget.total,
                max_agents: ctx.maxAgents,
                launch_stagger_ms: ctx.launchStaggerMs,
                ui: shouldLaunchUi(input),
                ...retryOpts.journal,
                ...transportJournal(options.transport, options.transport_strict)
            },
            state_path: statePathFor(id),
            workers: selectRoles(options.workers).map((worker) => ({
                ...worker,
                step_id: stepId({ kind: "role", role: worker.id, index: worker.index }),
                phase: null,
                model: options.model || null,
                reasoning_effort: options.reasoning_effort || null,
                status: "pending"
            })),
            events: ctx.events,
            aggregate_usage: ctx.usageTotals
        };
        await writeJson(workflow.state_path, workflow);
        const persister = makePersister(workflow, ctx);
        await attachWorkflowUi(workflow, ctx, input);
        if (workflow.ui) {
            persister.schedule();
            attachLiveJournalPersistence(workflow, ctx, persister);
        }
        const results = await Promise.all(workflow.workers.map((worker, i) => runLegacyWorker(options, workflow, worker, ctx, retryOpts.worker).then((record) => {
            workflow.workers[i] = record;
            persister.schedule();
            return record;
        })));
        workflow.workers = results;
        finalizeRecord(workflow, ctx);
        persister.schedule();
        await persister.flush();
        return workflow;
    }
    // Journaled resume: reload a persisted record, keep completed steps, and only
    // re-spawn missing / failed / explicitly-forced steps, then re-aggregate.
    async function resumeWorkflow(input = {}) {
        const record = await readWorkflow({ workflow_id: input.workflow_id, state_path: input.state_path });
        if (!record || record.status === "missing") {
            throw new Error("No Ultracode workflow state to resume.");
        }
        // A kind:'script' record (from runScript) has no per-worker steps to re-run:
        // a script is an arbitrary imperative body, not a step DAG. Rather than try to
        // re-derive role/spec workers (which would throw on the missing `task`), resume
        // degrades to a clear no-op that returns the record unchanged.
        if (record.kind === "script") {
            return {
                ...record,
                message: "Script workflows are not step-resumable; re-run the script to produce a fresh record."
            };
        }
        const force = new Set(input.force_steps || []);
        const ctx = createContext({
            workflowId: record.id,
            concurrency: record.options && record.options.concurrency,
            globalConcurrency: firstDefined(input.global_concurrency, input.globalConcurrency, record.options && record.options.global_concurrency),
            budgetTokens: record.options && record.options.budget_tokens,
            maxAgents: record.options && record.options.max_agents,
            launchStaggerMs: firstDefined(input.launch_stagger_ms, record.options && record.options.launch_stagger_ms),
            depth: Number(process.env.ULTRACODE_DEPTH || 0),
            onEvent: typeof input.on_event === "function" ? input.on_event : null,
            signal: input.signal
        });
        // Retry knobs are sourced from the journaled options first, with any new input
        // values taking precedence (so a resume can change them).
        const retryOpts = resolveRetryInput({
            max_retries: firstDefined(input.max_retries, record.options && record.options.max_retries),
            base_delay_ms: firstDefined(input.base_delay_ms, record.options && record.options.base_delay_ms),
            max_delay_ms: firstDefined(input.max_delay_ms, record.options && record.options.max_delay_ms),
            retry_jitter: firstDefined(input.retry_jitter, record.options && record.options.retry_jitter)
        });
        const rerun = [];
        record.workers.forEach((worker, i) => {
            const idMatches = force.has(worker.step_id) || force.has(worker.id) || force.has(String(worker.index));
            if (idMatches || worker.status !== "completed")
                rerun.push(i);
        });
        record.status = "running";
        record.completed_at = null;
        record.resumed_at = new Date().toISOString();
        record.options = {
            ...(record.options || {}),
            global_concurrency: ctx.globalConcurrency,
            ui: shouldLaunchUi(input)
        };
        record.events = ctx.events;
        if (rerun.length === 0) {
            log(ctx, "resume: all steps already completed; nothing to re-run.");
        }
        else {
            log(ctx, `resume: re-running ${rerun.length} of ${record.workers.length} steps.`, { rerun: rerun.length });
        }
        await writeJson(record.state_path, record);
        const persister = makePersister(record, ctx);
        await attachWorkflowUi(record, ctx, input);
        if (record.ui) {
            persister.schedule();
            attachLiveJournalPersistence(record, ctx, persister);
        }
        const baseOptions = normalizeOptions({
            task: record.task,
            cwd: record.cwd,
            workers: (record.options && record.options.workers) || 1,
            sandbox: (record.options && record.options.sandbox) || "read-only",
            model: record.options && record.options.model,
            reasoning_effort: record.options && record.options.reasoning_effort,
            timeout_ms: record.options && record.options.timeout_ms
        });
        await Promise.all(rerun.map((i) => {
            const worker = record.workers[i];
            const promise = worker.spec
                ? spawnWorker(worker.spec.prompt, {
                    ctx,
                    schema: worker.spec.schema,
                    sandbox: worker.spec.sandbox,
                    model: worker.spec.model || undefined,
                    reasoningEffort: worker.spec.reasoning_effort || undefined,
                    timeoutMs: worker.spec.timeout_ms,
                    cwd: worker.spec.cwd,
                    label: worker.label,
                    phase: worker.phase,
                    isolation: worker.spec.isolation || undefined,
                    ...retryOpts.worker
                }).then((result) => workerRecordFromResult(worker, result))
                : runLegacyWorker(baseOptions, { id: record.id, cwd: record.cwd }, worker, ctx, retryOpts.worker);
            return promise.then((updated) => {
                record.workers[i] = updated;
                persister.schedule();
                return updated;
            });
        }));
        finalizeRecord(record, ctx);
        persister.schedule();
        await persister.flush();
        return record;
    }
    return {
        workerRecordFromResult,
        resolveRetryInput,
        transportJournal,
        compactWorkflow,
        makePersister,
        attachLiveJournalPersistence,
        finalizeRecord,
        normalizeSpec,
        runWorkflow,
        resumeWorkflow
    };
};
