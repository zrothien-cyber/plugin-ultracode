"use strict";
const childProcess = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const util = require("util");
const appServerClient = require("../scripts/app-server-client");
const { acquireGlobalLease } = require("../scripts/global-concurrency");
const execFileP = util.promisify(childProcess.execFile);
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
// Worker transports and orchestration primitives. Dependencies flow from foundation.
function createExecution(foundation) {
    const { MAX_WORKERS, DEFAULT_TIMEOUT_MS, VALID_SANDBOXES, VALID_EFFORTS, WORKER_SCHEMA, VERDICT_SCHEMA, defaultCodexBin, codexHome, resolveModel, resolveReasoningEffort, emitEvent, log, accountUsage, validateAgainstSchema, classifyCodexError, backoffDelay, abortableDelay, abortError, waitForLaunchStagger, firstDefined, clampNonNegInt, resolveBool, resolveTransport, normalizeGlobalConcurrency } = foundation;
    function errorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
    function engineError(error) {
        return error instanceof Error ? error : new Error(String(error));
    }
    function isRecord(value) {
        return value !== null && typeof value === "object";
    }
    function notifyCtxWorkerHook(ctx, hookName, ...args) {
        if (!ctx || typeof ctx[hookName] !== "function")
            return;
        try {
            ctx[hookName](...args);
        }
        catch {
            /* worker progress hooks must never break worker execution */
        }
    }
    function createWorkerMeta(ctx, prompt, opts) {
        if (!ctx)
            return null;
        const index = ctx.nextWorkerIndex;
        ctx.nextWorkerIndex += 1;
        const id = `worker-${index + 1}`;
        return {
            index,
            id,
            step_id: id,
            title: opts.label,
            label: opts.label,
            phase: opts.phase || null,
            prompt,
            spec: {
                prompt,
                schema: opts.schema === undefined ? null : opts.schema,
                sandbox: opts.sandbox,
                model: opts.model || null,
                reasoning_effort: opts.reasoningEffort || null,
                timeout_ms: opts.timeoutMs,
                startup_timeout_ms: opts.startupTimeoutMs,
                cwd: opts.cwd,
                isolation: opts.isolation || null,
                executor: opts.executor || "cold",
                transport: opts.transport || "exec"
            },
            ...(opts.script_call_id ? { script_call_id: opts.script_call_id } : {}),
            ...(opts.cache_key ? { cache_key: opts.cache_key } : {})
        };
    }
    // ---------------------------------------------------------------------------
    // Codex subprocess layer
    // ---------------------------------------------------------------------------
    function workerPrompt({ task, workflow, worker, sandbox }) {
        return [
            `You are an Ultracode subprocess worker: ${worker.title}.`,
            `Workflow id: ${workflow.id}`,
            `Workspace: ${workflow.cwd}`,
            "",
            "Primary task:",
            task,
            "",
            "Your focus:",
            worker.focus,
            "",
            sandbox === "read-only"
                ? "You are running in a read-only worker lane. Inspect and reason; do not attempt to modify files."
                : "Only modify files if the user task explicitly requires this worker lane to do so.",
            "",
            "Return concrete evidence. Prefer paths, commands, risks, and next actions over generic advice.",
            "Your final response must satisfy the provided JSON schema exactly."
        ].join("\n");
    }
    function buildCodexArgs(opts, schemaPath, lastMessagePath) {
        const args = ["exec", "--json"];
        if (!opts.persistSession)
            args.push("--ephemeral");
        args.push("--skip-git-repo-check", "--sandbox", opts.sandbox, "-c", 'approval_policy="never"');
        if (schemaPath)
            args.push("--output-schema", schemaPath);
        args.push("--output-last-message", lastMessagePath, "--cd", opts.cwd);
        if (opts.model)
            args.push("-m", opts.model);
        if (opts.reasoningEffort)
            args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
        if (opts.profile)
            args.push("-p", opts.profile);
        for (const dir of opts.addDirs || [])
            args.push("--add-dir", dir);
        args.push("-");
        return args;
    }
    // Args for a WARM follow-up turn: `codex exec resume <session_id> <prompt>`.
    // SPIKE CONSTRAINT (verified against real codex-cli via clap parse errors, no
    // model calls): the `resume` subcommand REJECTS --output-schema, -s/--sandbox,
    // -C/--cd, --add-dir, and -p/--profile. Sandbox, cwd, and profile are inherited
    // from the original persisted session's session_meta, so they must NOT be
    // re-passed here. Schema on a resume turn is enforced out-of-band: the JSON
    // schema is injected into the prompt text AND validated post-hoc by the existing
    // validateAgainstSchema + schema-retry loop — never via --output-schema.
    //
    // Emits ONLY resume-supported flags: exec resume --json --skip-git-repo-check
    // <sessionId> -o <lastMessagePath>, plus -m model and
    // -c model_reasoning_effort=... when set, then `-` (stdin prompt).
    function buildResumeArgs(opts, sessionId, lastMessagePath) {
        const args = ["exec", "resume", "--json", "--skip-git-repo-check", sessionId, "-o", lastMessagePath];
        if (opts.model)
            args.push("-m", opts.model);
        if (opts.reasoningEffort)
            args.push("-c", `model_reasoning_effort=${JSON.stringify(opts.reasoningEffort)}`);
        args.push("-");
        return args;
    }
    // Detectable signal (verified against real codex-cli, no model call) that a
    // `codex exec resume <id>` turn cannot use the requested session: the resume
    // rollout is gone / unknown. Also treats any non-zero exit / missing-last-message
    // from a resume turn as "resume unavailable" so the worker can transparently fall
    // back to a cold exec rather than failing the run.
    const RESUME_UNAVAILABLE_RE = /no rollout found for thread id|thread\/resume|rollout not found|-32600/i;
    function isResumeUnavailable(error, execResult) {
        const caught = engineError(error);
        const exec = execResult || caught.codex_exec || null;
        const haystack = `${caught.message || ""}\n${exec ? `${exec.stderr || ""}\n${exec.stdout || ""}` : ""}`;
        if (RESUME_UNAVAILABLE_RE.test(haystack))
            return true;
        // A resume turn that exited non-zero (for any reason) or produced no readable
        // last-message is treated as resume-unavailable: warm context is a pure
        // optimization, so we degrade to cold rather than surface a resume-only error.
        if (exec && typeof exec.exit_code === "number" && exec.exit_code !== 0)
            return true;
        return false;
    }
    // Resume turns cannot pass --output-schema (the CLI rejects it). When a schema is
    // required, inject it into the prompt text so the model still targets the shape;
    // the existing post-hoc validateAgainstSchema + schema-retry loop enforces it.
    function injectSchemaIntoPrompt(prompt, schema) {
        if (!schema)
            return prompt;
        return [
            prompt,
            "",
            "Your final response MUST be a single JSON object that satisfies this JSON schema exactly (no prose, no code fences):",
            JSON.stringify(schema, null, 2)
        ].join("\n");
    }
    function parseUsage(stdout) {
        let latest = null;
        for (const line of stdout.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (isRecord(event) && event.type === "turn.completed" && event.usage) {
                latest = event.usage;
            }
        }
        return latest;
    }
    function spawnCodex({ bin, args, cwd, env, prompt, timeoutMs, startupTimeoutMs, onStreamEvent, signal }) {
        return new Promise((resolve, reject) => {
            // Abort before spawning: never create a child for an already-cancelled run.
            if (signal && signal.aborted) {
                reject(abortError(signal));
                return;
            }
            const startedAt = Date.now();
            let stdout = "";
            let stderr = "";
            let lineBuf = "";
            let threadId = null;
            let lastUsage = null;
            let settled = false;
            let timedOut = false;
            let startupTimedOut = false;
            let receivedOutput = false;
            let cancelled = false;
            let killTimer = null;
            let abortListener = null;
            let startupTimer = null;
            const child = childProcess.spawn(bin, args, {
                cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"]
            });
            const terminate = () => {
                if (settled)
                    return;
                try {
                    child.kill("SIGTERM");
                }
                catch {
                    /* child may already be gone */
                }
                if (!killTimer) {
                    killTimer = setTimeout(() => {
                        if (!settled) {
                            try {
                                child.kill("SIGKILL");
                            }
                            catch {
                                /* child may already be gone */
                            }
                        }
                    }, 5_000);
                }
            };
            const timer = setTimeout(() => {
                if (!settled) {
                    timedOut = true;
                    terminate();
                }
            }, timeoutMs);
            const effectiveStartupTimeoutMs = Math.max(1, Math.min(timeoutMs, Math.floor(Number(startupTimeoutMs)) || timeoutMs));
            startupTimer = setTimeout(() => {
                if (!settled && !receivedOutput && !threadId) {
                    startupTimedOut = true;
                    timedOut = true;
                    terminate();
                }
            }, effectiveStartupTimeoutMs);
            // Cancellation: reuse the proven timeout kill ladder (SIGTERM -> 5s ->
            // SIGKILL). The child's natural close/error path then settles via finish(),
            // which reports cancelled:true. kill() is wrapped because the child may have
            // already exited (harmless ESRCH).
            if (signal) {
                abortListener = () => {
                    if (settled)
                        return;
                    cancelled = true;
                    terminate();
                };
                signal.addEventListener("abort", abortListener, { once: true });
            }
            function processLine(rawLine) {
                const line = rawLine.trim();
                if (!line)
                    return;
                let event;
                try {
                    event = JSON.parse(line);
                }
                catch {
                    return;
                }
                if (!isRecord(event))
                    return;
                if (!threadId && typeof event.thread_id === "string")
                    threadId = event.thread_id;
                if (event.type === "thread.started" && typeof event.thread_id === "string")
                    threadId = event.thread_id;
                if (event.type === "turn.completed" && event.usage)
                    lastUsage = event.usage;
                if (onStreamEvent) {
                    try {
                        onStreamEvent(event);
                    }
                    catch {
                        /* ignore */
                    }
                }
            }
            function handleStdout(text) {
                if (text.length > 0 && !receivedOutput) {
                    receivedOutput = true;
                    if (startupTimer)
                        clearTimeout(startupTimer);
                    startupTimer = null;
                }
                stdout += text;
                lineBuf += text;
                let newline;
                while ((newline = lineBuf.indexOf("\n")) !== -1) {
                    const line = lineBuf.slice(0, newline);
                    lineBuf = lineBuf.slice(newline + 1);
                    processLine(line);
                }
            }
            function flushStdout() {
                if (lineBuf) {
                    const remaining = lineBuf;
                    lineBuf = "";
                    processLine(remaining);
                }
            }
            function finish(error, code, exitSignal) {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (startupTimer)
                    clearTimeout(startupTimer);
                if (killTimer)
                    clearTimeout(killTimer);
                if (signal && abortListener)
                    signal.removeEventListener("abort", abortListener);
                const result = {
                    pid: child.pid || null,
                    exit_code: code,
                    signal: exitSignal,
                    timed_out: timedOut,
                    startup_timed_out: startupTimedOut,
                    received_output: receivedOutput,
                    cancelled,
                    duration_ms: Date.now() - startedAt,
                    thread_id: threadId,
                    usage: lastUsage,
                    stdout,
                    stderr
                };
                if (error) {
                    error.codex_exec = result;
                    if (cancelled)
                        error.cancelled = true;
                    reject(error);
                }
                else {
                    resolve(result);
                }
            }
            child.stdout.on("data", (chunk) => handleStdout(chunk.toString("utf8")));
            child.stderr.on("data", (chunk) => {
                stderr += chunk.toString("utf8");
            });
            child.on("error", (error) => finish(error, null, null));
            child.on("close", (code, exitSignal) => {
                flushStdout();
                if (cancelled) {
                    finish(new Error("Codex worker cancelled."), code, exitSignal);
                    return;
                }
                if (timedOut) {
                    const message = startupTimedOut
                        ? `Codex worker did not start or emit output within ${effectiveStartupTimeoutMs}ms.`
                        : `Codex worker timed out after ${timeoutMs}ms.`;
                    finish(new Error(message), code, exitSignal);
                    return;
                }
                if (code !== 0) {
                    const detail = stderr.trim() || stdout.trim() || exitSignal || `exit code ${code}`;
                    finish(new Error(`Codex worker exited with ${detail}.`), code, exitSignal);
                    return;
                }
                finish(null, code, exitSignal);
            });
            // The child may exit / be killed (timeout SIGTERM/SIGKILL) before the prompt
            // finishes flushing, producing EPIPE on stdin. Without this listener that
            // would surface as an uncaught exception and take down the host process; the
            // child "close"/"error" handlers already settle the promise via finish().
            child.stdin.on("error", () => { });
            child.stdin.end(prompt);
        });
    }
    function resolveWorkerOpts(opts = {}) {
        const sandbox = opts.sandbox || "read-only";
        if (!VALID_SANDBOXES.has(sandbox)) {
            throw new Error(`sandbox must be one of: ${Array.from(VALID_SANDBOXES).join(", ")}.`);
        }
        const reasoningEffort = resolveReasoningEffort(opts.reasoningEffort || opts.reasoning_effort);
        if (reasoningEffort !== undefined && reasoningEffort !== null && !VALID_EFFORTS.has(reasoningEffort)) {
            throw new Error(`reasoning_effort must be one of: ${Array.from(VALID_EFFORTS).join(", ")}.`);
        }
        const schema = opts.schema === undefined ? WORKER_SCHEMA : opts.schema;
        // Warm-context executor selection. 'cold' (default) = unchanged cold exec
        // fan-out. 'resume' = keep a Codex session warm across turns via
        // `codex exec resume` (forces persistSession so a session id exists to resume).
        // 'fork' = forward-compat alias; the spike proved fork is interactive-TUI-only
        // with no --json, so it transparently degrades to cold (handled at the call
        // site that consults this value).
        const executor = opts.executor === "resume" || opts.executor === "fork" || opts.executor === "cold" ? opts.executor : "cold";
        const persistSession = !!opts.persistSession || executor === "resume";
        // Transport selection (opt-in, off-by-default). Sourced from the explicit
        // option, then the ULTRACODE_TRANSPORT env. Anything not exactly 'app-server'
        // or 'exec-server' resolves to 'exec' = today's path unchanged. 'strict' (off
        // by default) controls whether an app-server failure falls back to exec.
        const transport = resolveTransport(firstDefined(opts.transport, process.env.ULTRACODE_TRANSPORT));
        const transportStrict = resolveBool(firstDefined(opts.transport_strict, opts.transportStrict), false);
        const timeoutMs = opts.timeoutMs || opts.timeout_ms || DEFAULT_TIMEOUT_MS;
        const configuredStartupTimeoutMs = firstDefined(opts.startupTimeoutMs, opts.startup_timeout_ms, process.env.ULTRACODE_STARTUP_TIMEOUT_MS);
        const startupTimeoutMs = Math.max(1, Math.min(timeoutMs, Math.floor(Number(configuredStartupTimeoutMs)) > 0
            ? Math.floor(Number(configuredStartupTimeoutMs))
            : DEFAULT_STARTUP_TIMEOUT_MS));
        return {
            sandbox,
            model: resolveModel(opts.model),
            reasoningEffort,
            timeoutMs,
            startupTimeoutMs,
            globalConcurrency: normalizeGlobalConcurrency(firstDefined(opts.globalConcurrency, opts.global_concurrency, process.env.ULTRACODE_GLOBAL_CONCURRENCY)),
            cwd: path.resolve(opts.cwd || process.cwd()),
            bin: opts.codex_bin || defaultCodexBin(),
            codex_home: opts.codex_home || codexHome(),
            profile: typeof opts.profile === "string" && opts.profile.trim() ? opts.profile.trim() : undefined,
            addDirs: Array.isArray(opts.addDirs) ? opts.addDirs : [],
            persistSession,
            executor,
            transport,
            transportStrict,
            schema,
            schemaRetries: opts.schemaRetries === undefined ? (schema ? 1 : 0) : Math.max(0, Math.floor(Number(opts.schemaRetries))),
            // Transient-error retry knobs. maxRetries defaults to 0 => zero transient
            // retries => identical to the pre-retry engine on every non-zero exit.
            maxRetries: clampNonNegInt(firstDefined(opts.maxRetries, opts.max_retries), 0),
            baseDelayMs: clampNonNegInt(firstDefined(opts.baseDelayMs, opts.base_delay_ms), 500),
            maxDelayMs: clampNonNegInt(firstDefined(opts.maxDelayMs, opts.max_delay_ms), 30_000),
            retryJitter: resolveBool(firstDefined(opts.retryJitter, opts.retry_jitter), true),
            label: opts.label || opts.title || "worker",
            phase: opts.phase || null,
            isolation: opts.isolation === "worktree" ? "worktree" : undefined,
            script_call_id: opts.script_call_id || null,
            cache_key: opts.cache_key || null
        };
    }
    // Normalize an app-server camelCase TokenUsageBreakdown into the engine's
    // snake_case USAGE_KEYS shape. Re-exported via app-server-client so both layers
    // agree; kept here too for callers that already hold the engine module.
    function normalizeAppServerUsage(breakdown) {
        return appServerClient._internal.normalizeUsage(breakdown);
    }
    async function createWorktree(baseDir) {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ultracode-wt-"));
        // `git worktree add` requires the target path to not already exist.
        await fs.rm(dir, { recursive: true, force: true });
        await execFileP("git", ["-C", baseDir, "worktree", "add", "--detach", dir, "HEAD"]);
        return { dir, base: baseDir };
    }
    async function removeWorktree(worktree) {
        try {
            await execFileP("git", ["-C", worktree.base, "worktree", "remove", "--force", worktree.dir]);
        }
        catch {
            await fs.rm(worktree.dir, { recursive: true, force: true }).catch(() => { });
        }
    }
    async function collectDiff(worktree) {
        const { stdout } = await execFileP("git", ["-C", worktree.dir, "diff", "HEAD"], { maxBuffer: 32 * 1024 * 1024 });
        return stdout;
    }
    // resumeSessionId (default null): when null the byte-for-byte cold path runs
    // (buildCodexArgs, still appends --ephemeral unless persistSession). When a
    // session id is supplied the WARM path runs (buildResumeArgs) — no --output-schema
    // is written even when `schema` is set, because the resume subcommand rejects it;
    // the schema is enforced by the caller via prompt-injection + post-hoc validation.
    // Run one worker turn over the opt-in app-server JSON-RPC transport, then
    // post-process the accumulated assistant message EXACTLY as the exec path does:
    // JSON.parse it when a schema is set (the engine's retry loop then validates),
    // or trim it for raw-text workers. Returns the same { execResult, value }
    // contract as the exec branch so spawnWorkerGuarded is transport-agnostic.
    async function runAppServerAttempt({ prompt, schema, opts, onStreamEvent }) {
        const env = {
            ...process.env,
            CODEX_HOME: opts.codex_home,
            ULTRACODE_CHILD: "1",
            ULTRACODE_DEPTH: String((opts.depth || 0) + 1)
        };
        const { execResult, value: rawText } = await appServerClient.runAppServerTurn({
            prompt,
            schema,
            opts: {
                bin: opts.bin,
                cwd: opts.cwd,
                env,
                sandbox: opts.sandbox,
                model: opts.model,
                reasoningEffort: opts.reasoningEffort,
                baseInstructions: opts.baseInstructions,
                timeoutMs: opts.timeoutMs,
                signal: opts.signal
            },
            onStreamEvent,
            abortError
        });
        let value;
        try {
            value = schema ? JSON.parse(String(rawText)) : String(rawText || "").trim();
        }
        catch (error) {
            const err = new Error(schema
                ? `Worker did not return readable schema JSON: ${errorMessage(error)}`
                : `Worker output could not be read: ${errorMessage(error)}`);
            err.codex_exec = execResult;
            throw err;
        }
        return { execResult, value };
    }
    async function runCodexAttempt({ prompt, schema, opts, onStreamEvent, resumeSessionId = null }) {
        // 'exec-server' is reserved but not yet implemented — fail loudly so a caller
        // that opts into it gets a clear, actionable error rather than a silent
        // fallback. The seam (app-server-client) is generic enough to host it later.
        if (opts.transport === "exec-server") {
            throw new Error("transport 'exec-server' is not yet implemented; use 'exec' (default) or 'app-server'.");
        }
        // OPT-IN app-server transport. Only used for a fresh (non-resume) cold turn —
        // warm resume is an exec-only concept. On ANY app-server failure we
        // transparently fall back to the exec path (unless transportStrict is set),
        // logging a narrator line via the supplied onStreamEvent/onLog sink.
        if (opts.transport === "app-server" && !resumeSessionId) {
            try {
                return await runAppServerAttempt({ prompt, schema, opts, onStreamEvent });
            }
            catch (error) {
                if (opts.transportStrict) {
                    throw error;
                }
                if (typeof opts.onTransportFallback === "function") {
                    try {
                        opts.onTransportFallback(engineError(error));
                    }
                    catch {
                        /* narrator errors never break a run */
                    }
                }
                // Fall through to the exec path with the original prompt/schema/opts.
            }
        }
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ultracode-"));
        // The schema file is only ever passed to the cold builder. On a resume turn we
        // still keep `schema` (for post-hoc validation) but never write/pass the file.
        const schemaPath = !resumeSessionId && schema ? path.join(tempDir, "worker.schema.json") : null;
        const lastMessagePath = path.join(tempDir, "last-message.json");
        if (schemaPath)
            await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), "utf8");
        const args = resumeSessionId
            ? buildResumeArgs(opts, resumeSessionId, lastMessagePath)
            : buildCodexArgs(opts, schemaPath, lastMessagePath);
        const env = {
            ...process.env,
            CODEX_HOME: opts.codex_home,
            ULTRACODE_CHILD: "1",
            ULTRACODE_DEPTH: String((opts.depth || 0) + 1)
        };
        try {
            const execResult = await spawnCodex({
                bin: opts.bin,
                args,
                cwd: opts.cwd,
                env,
                prompt,
                timeoutMs: opts.timeoutMs,
                startupTimeoutMs: opts.startupTimeoutMs,
                onStreamEvent,
                signal: opts.signal
            });
            let value;
            try {
                const raw = await fs.readFile(lastMessagePath, "utf8");
                value = schema ? JSON.parse(raw) : raw.trim();
            }
            catch (error) {
                // Attach the exec result so callers can still account token usage for a
                // run that completed but whose last-message file was missing/unparseable.
                const err = new Error(schema
                    ? `Worker did not return readable schema JSON: ${errorMessage(error)}`
                    : `Worker output could not be read: ${errorMessage(error)}`);
                err.codex_exec = execResult;
                throw err;
            }
            return { execResult, value };
        }
        finally {
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    }
    function failedWorker(label, phase, error, codexExec, usage, durationMs, status) {
        return {
            status: status || "failed",
            value: null,
            result: null,
            usage: usage || null,
            thread_id: null,
            duration_ms: durationMs || 0,
            label,
            phase: phase || null,
            error,
            codex_exec: codexExec
        };
    }
    // A non-throwing "cancelled" worker record. Like failedWorker but status maps to
    // 'cancelled' so finalizeRecord can mark a deliberately-aborted run distinctly
    // from a genuine failure. Every primitive already treats non-'completed' as a
    // drop, so runParallel/runPipeline/loopUntilDry keep working unchanged.
    function cancelledWorker(label, phase, reason) {
        return failedWorker(label, phase, reason || "cancelled", undefined, null, 0, "cancelled");
    }
    // Atomic agent() equivalent. Spawns one `codex exec` with an arbitrary prompt,
    // an optional per-call JSON schema (null => raw text), validates + retries on
    // schema mismatch, accounts usage/caps into ctx, and emits progress events.
    // Never throws: failures resolve to a {status:'failed'} record.
    async function spawnWorker(prompt, opts = {}) {
        const ctx = opts.ctx || null;
        const resolved = resolveWorkerOpts({ ...opts, depth: ctx ? ctx.depth : 0 });
        const workerMeta = createWorkerMeta(ctx, prompt, resolved);
        const resolvedWithMeta = workerMeta
            ? { ...resolved, worker_id: workerMeta.id, worker_index: workerMeta.index }
            : resolved;
        // resumeSessionId is only honored when the caller opted into executor:'resume'.
        // For any other executor (cold/fork) it is forced null so the cold path runs
        // byte-for-byte as before — the warm path is purely additive and opt-in.
        const resumeSessionId = resolvedWithMeta.executor === "resume" && typeof opts.resumeSessionId === "string" && opts.resumeSessionId
            ? opts.resumeSessionId
            : null;
        notifyCtxWorkerHook(ctx, "onWorkerPending", workerMeta);
        const exec = () => spawnWorkerGuarded(prompt, resolvedWithMeta, ctx, resumeSessionId);
        const result = await (ctx ? ctx.limiter.run(exec) : exec());
        notifyCtxWorkerHook(ctx, "onWorkerRecord", result, workerMeta);
        return result;
    }
    async function spawnWorkerGuarded(prompt, opts, ctx, resumeSessionId = null) {
        const { label, phase, worker_id: workerId, worker_index: workerIndex } = opts;
        const workerEvent = (event) => ({
            ...event,
            ...(workerId ? { worker_id: workerId } : {}),
            ...(workerIndex !== undefined && workerIndex !== null ? { worker_index: workerIndex } : {})
        });
        // Re-evaluated before every spawn (including schema retries) so neither the
        // token budget nor the lifetime agent cap can be overshot by retries.
        const capExceeded = () => {
            if (ctx && ctx.budget.total !== null && ctx.budget.remaining() <= 0) {
                log(ctx, `Skipping worker "${label}": token budget exhausted.`, { label, reason: "budget" });
                return failedWorker(label, phase, "token budget exhausted");
            }
            if (ctx && ctx.spawnedCount >= ctx.maxAgents) {
                log(ctx, `Skipping worker "${label}": lifetime agent cap (${ctx.maxAgents}) reached.`, {
                    label,
                    reason: "maxAgents"
                });
                return failedWorker(label, phase, `lifetime agent cap ${ctx.maxAgents} reached`);
            }
            return null;
        };
        if (ctx && ctx.depth > ctx.maxDepth) {
            log(ctx, `Skipping worker "${label}": nesting depth ${ctx.depth} exceeds max ${ctx.maxDepth}.`, {
                label,
                reason: "maxDepth"
            });
            return failedWorker(label, phase, `nesting depth ${ctx.depth} exceeds max ${ctx.maxDepth}`);
        }
        // Cancellation gate (entry): if the run was already aborted, never schedule a
        // child — return a non-throwing cancelled record. No-op when ctx.signal is
        // never aborted (the default), so the happy path is unchanged.
        if (ctx && ctx.signal && ctx.signal.aborted) {
            log(ctx, `Worker "${label}" cancelled before start.`, { label, reason: "cancelled" });
            return cancelledWorker(label, phase, "cancelled");
        }
        const entryGate = capExceeded();
        if (entryGate)
            return entryGate;
        let worktree = null;
        let runOpts = opts;
        if (opts.isolation === "worktree") {
            try {
                worktree = await createWorktree(opts.cwd);
                runOpts = {
                    ...opts,
                    cwd: worktree.dir,
                    sandbox: opts.sandbox === "read-only" ? "workspace-write" : opts.sandbox
                };
            }
            catch (error) {
                log(ctx, `Worktree isolation failed for "${label}"; falling back to shared cwd: ${errorMessage(error)}`, {
                    label,
                    reason: "worktree-fallback"
                });
            }
        }
        emitEvent(ctx, workerEvent({ type: "worker.started", label, phase }));
        // fork executor stub: the spike proved `codex fork` is interactive-TUI-only
        // (no --json, no `codex exec fork`), so it cannot share a warm base session
        // non-interactively. We accept executor:'fork' for forward-compat but log it
        // and run the cold path (resumeSessionId is already null for fork).
        if (opts.executor === "fork") {
            log(ctx, "fork executor not supported by codex CLI (interactive-only); using cold exec", {
                label,
                reason: "fork-unsupported"
            });
        }
        try {
            let attempt = 0;
            // Independent of the schema-retry `attempt`: a transient retry never consumes
            // a schema retry and vice-versa.
            let transientAttempt = 0;
            // Warm-context state. `activeResume` is the session id we attempt this turn;
            // it is cleared (=> cold) when the resume subprocess signals unavailability,
            // so the very next loop iteration transparently re-runs the same prompt cold.
            // Only meaningful when executor:'resume' AND a session id was supplied.
            let activeResume = opts.executor === "resume" ? resumeSessionId || null : null;
            // On a resume turn the schema must be embedded in the prompt (the CLI rejects
            // --output-schema), so warm and cold use different base prompts.
            const buildPrompt = () => activeResume ? injectSchemaIntoPrompt(prompt, opts.schema) : prompt;
            let currentPrompt = buildPrompt();
            while (true) {
                // Cancellation gate (loop top): stop scheduling new attempts once aborted.
                if (ctx && ctx.signal && ctx.signal.aborted) {
                    log(ctx, `Worker "${label}" cancelled.`, { label, reason: "cancelled" });
                    return cancelledWorker(label, phase, "cancelled");
                }
                const loopGate = capExceeded();
                if (loopGate)
                    return loopGate;
                try {
                    await waitForLaunchStagger(ctx, label, phase);
                }
                catch {
                    emitEvent(ctx, workerEvent({ type: "worker.cancelled", label, phase }));
                    log(ctx, `Worker "${label}" cancelled during launch stagger.`, { label, reason: "cancelled" });
                    return cancelledWorker(label, phase, "cancelled");
                }
                const postStaggerGate = capExceeded();
                if (postStaggerGate)
                    return postStaggerGate;
                let attemptResult;
                let globalLease = null;
                try {
                    const globalConcurrency = ctx ? ctx.globalConcurrency : runOpts.globalConcurrency;
                    globalLease = await acquireGlobalLease({
                        codexHome: runOpts.codex_home,
                        limit: globalConcurrency,
                        signal: ctx ? ctx.signal : undefined,
                        onWait: ({ active, limit }) => {
                            emitEvent(ctx, workerEvent({ type: "worker.global_wait", label, phase, active, limit }));
                            log(ctx, `Worker "${label}" waiting for a global concurrency slot (${active}/${limit}).`, {
                                label,
                                reason: "global-concurrency",
                                active,
                                global_concurrency: limit
                            });
                        }
                    });
                    if (globalLease.waited_ms > 0) {
                        emitEvent(ctx, workerEvent({
                            type: "worker.global_acquired",
                            label,
                            phase,
                            wait_ms: globalLease.waited_ms,
                            active: globalLease.active,
                            limit: globalLease.limit
                        }));
                    }
                    if (ctx && ctx.signal && ctx.signal.aborted) {
                        emitEvent(ctx, workerEvent({ type: "worker.cancelled", label, phase }));
                        log(ctx, `Worker "${label}" cancelled while waiting for global concurrency.`, { label, reason: "cancelled" });
                        return cancelledWorker(label, phase, "cancelled");
                    }
                    const postAdmissionGate = capExceeded();
                    if (postAdmissionGate)
                        return postAdmissionGate;
                    if (ctx)
                        ctx.spawnedCount += 1;
                    attemptResult = await runCodexAttempt({
                        prompt: currentPrompt,
                        schema: opts.schema,
                        opts: {
                            ...runOpts,
                            depth: ctx ? ctx.depth : 0,
                            signal: ctx ? ctx.signal : undefined,
                            // Narrator hook for the opt-in app-server transport: on any
                            // app-server failure (with transportStrict off) the engine logs a
                            // line, emits a worker.transport_fallback event, and re-runs this
                            // same attempt over the exec path. No-op for the default exec
                            // transport, so the happy path is unchanged.
                            onTransportFallback: (error) => {
                                log(ctx, `app-server transport failed for "${label}"; falling back to exec: ${error.message}`, {
                                    label,
                                    reason: "transport-fallback"
                                });
                                emitEvent(ctx, workerEvent({ type: "worker.transport_fallback", label, phase, error: error.message }));
                            }
                        },
                        resumeSessionId: activeResume,
                        onStreamEvent: (event) => {
                            if (event.type === "turn.completed" && event.usage) {
                                emitEvent(ctx, workerEvent({ type: "turn.completed", label, phase }));
                            }
                        }
                    });
                }
                catch (error) {
                    const caught = engineError(error);
                    const execResult = caught.codex_exec;
                    const usage = execResult ? execResult.usage || parseUsage(execResult.stdout || "") : null;
                    accountUsage(ctx, usage);
                    // Warm-context safety net: a resume attempt that the CLI could not honor
                    // (unknown/expired rollout, non-zero exit, missing last-message) is NOT a
                    // run failure — clear the session id, log resume-fallback, and re-run the
                    // SAME prompt cold on the next loop iteration. This consumes neither a
                    // schema retry nor a transient retry, so warm mode can only ever make a
                    // run faster/cheaper, never change its correctness.
                    if (activeResume && !(ctx && ctx.signal && ctx.signal.aborted) && isResumeUnavailable(caught, execResult)) {
                        log(ctx, "resume unavailable; fell back to cold exec", { label, reason: "resume-fallback" });
                        emitEvent(ctx, workerEvent({ type: "worker.resume_fallback", label, phase }));
                        activeResume = null;
                        currentPrompt = buildPrompt();
                        continue;
                    }
                    // An abort that fired during the attempt surfaces as a cancelled error —
                    // report it as cancelled, not a transient/permanent failure.
                    const aborted = caught.cancelled === true || (execResult && execResult.cancelled === true) ||
                        (ctx && ctx.signal && ctx.signal.aborted);
                    if (aborted) {
                        emitEvent(ctx, workerEvent({ type: "worker.cancelled", label, phase }));
                        log(ctx, `Worker "${label}" cancelled.`, { label, reason: "cancelled" });
                        return cancelledWorker(label, phase, "cancelled");
                    }
                    // Classify: transient (retry with backoff) vs permanent (fail now, as the
                    // engine always did). maxRetries defaults to 0; only narrowly-classified
                    // auth-refresh races get one implicit restart without an explicit retry budget.
                    const classification = classifyCodexError(caught, execResult);
                    const effectiveMaxRetries = Math.max(opts.maxRetries, classification.defaultMaxRetries || 0);
                    const canRetry = classification.transient &&
                        transientAttempt < effectiveMaxRetries &&
                        !(ctx && ctx.signal && ctx.signal.aborted) &&
                        !capExceeded();
                    if (canRetry) {
                        const backoffMs = backoffDelay(transientAttempt, opts.baseDelayMs, opts.maxDelayMs, opts.retryJitter);
                        transientAttempt += 1;
                        emitEvent(ctx, workerEvent({
                            type: "worker.retry",
                            label,
                            phase,
                            attempt: transientAttempt,
                            max_retries: effectiveMaxRetries,
                            reason: classification.reason,
                            delay_ms: backoffMs
                        }));
                        log(ctx, `Worker "${label}" transient failure (${classification.reason}); retry ${transientAttempt}/${effectiveMaxRetries} in ${backoffMs}ms.`, { label, reason: "transient-retry", attempt: transientAttempt, delay_ms: backoffMs });
                        try {
                            await abortableDelay(backoffMs, ctx ? ctx.signal : undefined);
                        }
                        catch {
                            // Aborted during backoff: stop retrying, report cancelled.
                            emitEvent(ctx, workerEvent({ type: "worker.cancelled", label, phase }));
                            log(ctx, `Worker "${label}" cancelled during retry backoff.`, { label, reason: "cancelled" });
                            return cancelledWorker(label, phase, "cancelled");
                        }
                        continue;
                    }
                    emitEvent(ctx, workerEvent({ type: "worker.failed", label, phase, error: caught.message }));
                    log(ctx, `Worker "${label}" failed: ${caught.message}`, { label, reason: "exec-error" });
                    return failedWorker(label, phase, caught.message, execResult, usage, execResult ? execResult.duration_ms : 0);
                }
                finally {
                    if (globalLease)
                        await globalLease.release().catch(() => { });
                }
                const { execResult, value } = attemptResult;
                const usage = execResult.usage || parseUsage(execResult.stdout);
                accountUsage(ctx, usage);
                let schemaValid = true;
                if (opts.schema) {
                    const validation = validateAgainstSchema(value, opts.schema);
                    schemaValid = validation.ok;
                    if (!schemaValid && attempt < opts.schemaRetries) {
                        attempt += 1;
                        log(ctx, `Worker "${label}" output failed schema validation (retry ${attempt}/${opts.schemaRetries}).`, {
                            label,
                            errors: validation.errors,
                            reason: "schema-retry"
                        });
                        // On a warm resume turn the schema cannot be passed via --output-schema,
                        // so keep it embedded in the retry prompt too (cold turns keep the
                        // original wording byte-for-byte).
                        currentPrompt = `${buildPrompt()}\n\nYour previous response failed schema validation with these errors:\n- ${validation.errors.join("\n- ")}\nReturn a corrected response that satisfies the schema exactly.`;
                        continue;
                    }
                    if (!schemaValid) {
                        log(ctx, `Worker "${label}" output still invalid after ${opts.schemaRetries} retries; accepting best effort.`, {
                            label,
                            errors: validation.errors,
                            reason: "schema-accept-invalid"
                        });
                    }
                }
                let diff;
                if (worktree) {
                    diff = await collectDiff(worktree).catch(() => null);
                }
                emitEvent(ctx, workerEvent({ type: "worker.completed", label, phase, schema_valid: schemaValid }));
                return {
                    status: "completed",
                    value,
                    result: value,
                    usage,
                    thread_id: execResult.thread_id || null,
                    duration_ms: execResult.duration_ms,
                    label,
                    phase,
                    ...(workerId ? { worker_id: workerId } : {}),
                    ...(workerIndex !== undefined && workerIndex !== null ? { worker_index: workerIndex } : {}),
                    schema_valid: schemaValid,
                    ...(worktree ? { worktree: worktree.dir, diff } : {})
                };
            }
        }
        finally {
            if (worktree)
                await removeWorktree(worktree);
        }
    }
    // Warm-context worker handle. The first turn runs a normal PERSISTED cold exec
    // (executor:'resume' forces persistSession=true) and captures its session id
    // (thread_id). Every subsequent turn() resumes that same warm session via
    // `codex exec resume <sessionId>` — reusing the prior conversation context
    // instead of paying for a fresh cold exec. If the first turn yields no session id
    // (or any later resume turn signals the rollout is gone), the handle transparently
    // degrades to cold for that turn — warm is a pure latency/cost optimization that
    // can never change correctness.
    //
    // Returns a handle synchronously-shaped object once awaited:
    //   { sessionId, result, turn(prompt, perTurnOpts) }
    // `result` is the first-turn spawnWorker record; `sessionId` is its thread_id (or
    // null if none was captured). `turn()` is the explicit follow-up-turn API for
    // multi-stage pipelines; turns are SEQUENTIAL by nature (a resume continues one
    // conversation), so a single handle cannot run turns in parallel.
    async function spawnWarmWorker(initialPrompt, opts = {}) {
        // Force the resume executor for this handle so persistSession is on and a
        // session id is captured. A caller may still pass executor:'cold' to disable
        // warming entirely (every turn then runs cold) — honored as an explicit opt-out.
        const executor = opts.executor === "cold" || opts.executor === "fork" ? opts.executor : "resume";
        const baseOpts = { ...opts, executor };
        const first = await spawnWorker(initialPrompt, baseOpts);
        const sessionId = executor === "resume" && first && first.status === "completed" && first.thread_id ? first.thread_id : null;
        const handle = {
            sessionId,
            result: first,
            async turn(prompt, perTurnOpts = {}) {
                // Each follow-up turn resumes the captured session. spawnWorker forces the
                // resumeSessionId to null unless executor:'resume' AND a session id exists,
                // and the guarded path auto-falls-back to cold on any resume failure — so a
                // missing/expired session id here simply runs a cold exec.
                const turnOpts = {
                    ...baseOpts,
                    ...perTurnOpts,
                    executor: handle.sessionId ? "resume" : executor,
                    resumeSessionId: handle.sessionId || undefined
                };
                const r = await spawnWorker(prompt, turnOpts);
                // Keep warming the SAME session: only adopt a new session id if we still
                // don't have one (e.g. the first turn fell back to cold and a later turn
                // managed to persist a session). Never overwrite a working warm session.
                if (!handle.sessionId && r && r.status === "completed" && r.thread_id) {
                    handle.sessionId = r.thread_id;
                }
                return r;
            }
        };
        return handle;
    }
    // Barrier gather over arbitrary thunks. Any thunk that throws degrades to null
    // (logged), so merge/dedup/quorum steps can rely on a stable-length array.
    async function runParallel(thunks, opts = {}) {
        const ctx = opts.ctx || null;
        return Promise.all(thunks.map((thunk, index) => Promise.resolve()
            .then(thunk)
            .catch((error) => {
            log(ctx, `parallel: task #${index} threw and was dropped to null: ${errorMessage(error)}`, {
                index,
                reason: "exception"
            });
            return null;
        })));
    }
    // A per-item warm session helper handed to stages as the 5th argument when
    // runPipeline is invoked with opts.warm. Lazily creates a spawnWarmWorker handle
    // on first start() and resumes it on every turn(), so one item's stages reuse ONE
    // warm Codex session instead of N cold execs. base carries codex_bin/cwd/etc from
    // runPipeline opts so stages don't have to re-thread them.
    function createWarmStageHelper(base) {
        let handle = null;
        return {
            get sessionId() {
                return handle ? handle.sessionId : null;
            },
            // Start (or restart) the warm session with an initial prompt. Returns the
            // first-turn spawnWorker record.
            async start(prompt, perCallOpts = {}) {
                handle = await spawnWarmWorker(prompt, { ...base, ...perCallOpts });
                return handle.result;
            },
            // Resume the warm session for a follow-up stage. If start() was never called
            // (or yielded no session), this transparently runs a cold exec.
            async turn(prompt, perCallOpts = {}) {
                if (!handle) {
                    // No warm base yet: degrade to a single cold worker for this stage.
                    return spawnWorker(prompt, { ...base, ...perCallOpts, executor: "cold" });
                }
                return handle.turn(prompt, perCallOpts);
            }
        };
    }
    // Barrier-free multi-stage streaming. Each item flows through every stage
    // independently (no inter-stage barrier) — item A can be in stage 3 while item
    // B is still in stage 1. A throwing stage drops that one item to null.
    //
    // opt-in opts.warm: when true, each item gets a per-item warm-session helper
    // (5th stage arg) so the item's stages reuse ONE warm Codex session across
    // stages (warm turns are sequential, which the per-item chain already is). Warm
    // reuse is per-item; fan-out ACROSS items stays parallel (independent sessions).
    // When opts.warm is unset, stages are called with the exact 4-arg signature as
    // before and the 5th arg is null — byte-for-byte the current behavior.
    async function runPipeline(items, stages, opts = {}) {
        const ctx = opts.ctx || null;
        const warmBase = opts.warm
            ? {
                ctx,
                sandbox: opts.sandbox,
                model: opts.model,
                reasoningEffort: opts.reasoningEffort,
                timeoutMs: opts.timeoutMs,
                cwd: opts.cwd,
                codex_bin: opts.codex_bin,
                codex_home: opts.codex_home,
                schema: opts.schema
            }
            : null;
        const chains = items.map((item, index) => (async () => {
            let acc = item;
            const warm = warmBase ? createWarmStageHelper(warmBase) : null;
            for (let stage = 0; stage < stages.length; stage += 1) {
                try {
                    acc = await stages[stage](acc, item, index, ctx, warm);
                }
                catch (error) {
                    log(ctx, `pipeline: item #${index} dropped at stage ${stage}: ${errorMessage(error)}`, {
                        index,
                        stage,
                        reason: "exception"
                    });
                    return null;
                }
            }
            return acc;
        })());
        return Promise.all(chains);
    }
    function defaultLoopItems(value) {
        if (!isRecord(value))
            return [];
        if (Array.isArray(value.findings))
            return value.findings;
        if (Array.isArray(value.claims))
            return value.claims;
        if (Array.isArray(value.sources))
            return value.sources;
        return [];
    }
    function stableLoopKey(value) {
        if (typeof value === "string")
            return value.replace(/\s+/g, " ").trim();
        if (!isRecord(value))
            return String(value);
        for (const key of ["id", "key", "url", "href", "link", "source", "path", "file"]) {
            if (typeof value[key] === "string" && value[key].trim())
                return value[key].replace(/\s+/g, " ").trim();
        }
        if (typeof value.claim === "string" && typeof value.source === "string") {
            return `${value.claim.replace(/\s+/g, " ").trim()} :: ${value.source.replace(/\s+/g, " ").trim()}`;
        }
        return stableJson(value);
    }
    function stableJson(value) {
        if (!isRecord(value) && !Array.isArray(value))
            return JSON.stringify(value);
        if (Array.isArray(value))
            return `[${value.map(stableJson).join(",")}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    // Discovery loop: repeatedly spawn finders until K consecutive dry rounds, or a
    // round / budget / lifetime cap is hit (the stop reason is always logged).
    async function loopUntilDry(makePrompt, opts = {}) {
        const ctx = opts.ctx || null;
        const schema = opts.schema === undefined ? WORKER_SCHEMA : opts.schema;
        const dryRounds = opts.dryRounds || 2;
        const maxRounds = opts.maxRounds || 10;
        const dedupe = Boolean(opts.dedupe || opts.dedupeFindings || opts.dedupe_findings || opts.dedupeSources || opts.dedupe_sources);
        const extractItems = typeof opts.extractItems === "function" ? opts.extractItems : defaultLoopItems;
        const keyItem = typeof opts.dedupeKey === "function" ? opts.dedupeKey : stableLoopKey;
        const isDry = typeof opts.isDry === "function"
            ? opts.isDry
            : (result) => !result || (isRecord(result) && Array.isArray(result.findings) && result.findings.length === 0);
        const collected = [];
        const seen = opts.seen instanceof Set
            ? opts.seen
            : new Set(Array.isArray(opts.seen) ? opts.seen.map((item) => String(item)) : []);
        const state = opts.state && typeof opts.state === "object" ? opts.state : {};
        Object.assign(state, {
            collected,
            seen,
            seenList: Array.from(seen),
            consecutiveDry: 0,
            dryRounds,
            maxRounds,
            lastResult: null,
            lastValue: null,
            lastFresh: [],
            lastDuplicates: []
        });
        let consecutiveDry = 0;
        let round = 0;
        while (round < maxRounds && consecutiveDry < dryRounds) {
            if (ctx && ctx.budget.total !== null && ctx.budget.remaining() <= 0) {
                log(ctx, `loopUntilDry stopped after ${round} rounds: token budget exhausted.`, { reason: "budget" });
                break;
            }
            if (ctx && ctx.spawnedCount >= ctx.maxAgents) {
                log(ctx, `loopUntilDry stopped after ${round} rounds: lifetime agent cap reached.`, { reason: "maxAgents" });
                break;
            }
            state.round = round;
            state.consecutiveDry = consecutiveDry;
            state.seenList = Array.from(seen);
            const result = await spawnWorker(makePrompt(round, ctx, state), {
                ctx,
                schema,
                sandbox: opts.sandbox,
                model: opts.model,
                reasoningEffort: opts.reasoningEffort,
                timeoutMs: opts.timeoutMs || opts.timeout_ms,
                cwd: opts.cwd,
                codex_bin: opts.codex_bin,
                codex_home: opts.codex_home,
                transport: opts.transport,
                transport_strict: opts.transport_strict,
                label: `finder-round-${round + 1}`,
                phase: opts.phase,
                maxRetries: firstDefined(opts.maxRetries, opts.max_retries),
                baseDelayMs: firstDefined(opts.baseDelayMs, opts.base_delay_ms),
                maxDelayMs: firstDefined(opts.maxDelayMs, opts.max_delay_ms),
                retryJitter: firstDefined(opts.retryJitter, opts.retry_jitter)
            });
            round += 1;
            state.lastResult = result;
            state.lastValue = result.value;
            let fresh = [];
            let duplicates = [];
            let dedupeDry = false;
            if (result.status === "completed" && dedupe) {
                const items = extractItems(result.value) || [];
                for (const item of items) {
                    const rawKey = keyItem(item);
                    if (rawKey === undefined || rawKey === null)
                        continue;
                    const key = String(rawKey);
                    if (!key)
                        continue;
                    if (seen.has(key))
                        duplicates.push(item);
                    else {
                        seen.add(key);
                        fresh.push(item);
                    }
                }
                dedupeDry = items.length > 0 && fresh.length === 0;
                state.seenList = Array.from(seen);
                state.lastFresh = fresh;
                state.lastDuplicates = duplicates;
            }
            if (result.status !== "completed" || isDry(result.value) || dedupeDry) {
                consecutiveDry += 1;
                state.consecutiveDry = consecutiveDry;
                if (dedupeDry) {
                    log(ctx, `loopUntilDry: round ${round} repeated ${duplicates.length} seen item(s).`, { round, reason: "dedupe" });
                }
                log(ctx, `loopUntilDry: round ${round} dry (${consecutiveDry}/${dryRounds}).`, { round });
                continue;
            }
            consecutiveDry = 0;
            state.consecutiveDry = consecutiveDry;
            collected.push(result.value);
        }
        state.round = round;
        state.done = true;
        if (round >= maxRounds)
            log(ctx, `loopUntilDry reached maxRounds=${maxRounds}.`, { reason: "maxRounds" });
        return collected;
    }
    // Quality helper: for each finding, fan out N skeptic workers (optionally with
    // distinct lenses) and keep only findings that survive a majority refute vote.
    async function adversarialVerify(findings, opts = {}) {
        const ctx = opts.ctx || null;
        const skeptics = Math.max(1, opts.skeptics || 3);
        const lenses = Array.isArray(opts.lenses) && opts.lenses.length ? opts.lenses : null;
        const schema = opts.schema || VERDICT_SCHEMA;
        const describe = typeof opts.describe === "function"
            ? opts.describe
            : (finding) => (typeof finding === "string" ? finding : JSON.stringify(finding, null, 2));
        const verdicts = await Promise.all(findings.map(async (finding) => {
            const votes = await Promise.all(Array.from({ length: skeptics }, (_, i) => {
                const lens = lenses ? lenses[i % lenses.length] : null;
                const prompt = [
                    lens ? `Evaluate strictly from this perspective: ${lens}.` : "",
                    "You are a skeptical reviewer. Try hard to REFUTE the following finding.",
                    "If you cannot clearly confirm it is real and correct, set refuted=true.",
                    "",
                    "Finding:",
                    describe(finding),
                    opts.context ? `\nContext:\n${opts.context}` : ""
                ]
                    .filter(Boolean)
                    .join("\n");
                return spawnWorker(prompt, {
                    ctx,
                    schema,
                    sandbox: opts.sandbox || "read-only",
                    model: opts.model,
                    reasoningEffort: opts.reasoningEffort,
                    timeoutMs: opts.timeoutMs || opts.timeout_ms,
                    cwd: opts.cwd,
                    codex_bin: opts.codex_bin,
                    codex_home: opts.codex_home,
                    transport: opts.transport,
                    transport_strict: opts.transport_strict,
                    label: `skeptic${lens ? `:${lens}` : ""}`,
                    phase: opts.phase,
                    maxRetries: firstDefined(opts.maxRetries, opts.max_retries),
                    baseDelayMs: firstDefined(opts.baseDelayMs, opts.base_delay_ms),
                    maxDelayMs: firstDefined(opts.maxDelayMs, opts.max_delay_ms),
                    retryJitter: firstDefined(opts.retryJitter, opts.retry_jitter)
                }).then((result) => (result.status === "completed" ? result.value : null));
            }));
            const valid = votes.filter(Boolean);
            const refutes = valid.filter((vote) => isRecord(vote) && vote.refuted === true).length;
            // A finding is killed only when refuters are a strict majority, so an even
            // split (e.g. 1 of 2, 2 of 4) survives — matching the documented rule.
            const survives = valid.length > 0 && refutes * 2 <= valid.length;
            if (!survives) {
                log(ctx, `adversarialVerify: finding refuted by majority (${refutes}/${valid.length || skeptics}).`, {
                    finding: describe(finding).slice(0, 160)
                });
            }
            return { finding, survives };
        }));
        return verdicts.filter((entry) => entry.survives).map((entry) => entry.finding);
    }
    return {
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
    };
}
module.exports = createExecution;
