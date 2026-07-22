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
exports.globalConcurrencyDir = globalConcurrencyDir;
exports.acquireGlobalLease = acquireGlobalLease;
const crypto = __importStar(require("crypto"));
const fsSync = __importStar(require("fs"));
const fs = __importStar(require("fs/promises"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const LOCK_RETRY_MS = 25;
const LEASE_RETRY_MS = 75;
const ORPHAN_LOCK_MS = 15_000;
function isRecord(value) {
    return value !== null && typeof value === "object";
}
function isAlreadyExists(error) {
    return isRecord(error) && error.code === "EEXIST";
}
function isLivePid(pid) {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return isRecord(error) && error.code === "EPERM";
    }
}
function abortError(signal) {
    const reason = signal && typeof signal.reason === "string" ? signal.reason : "cancelled";
    const error = new Error(`Global concurrency wait ${reason}.`);
    error.name = "AbortError";
    return error;
}
function assertNotAborted(signal) {
    if (signal && signal.aborted)
        throw abortError(signal);
}
function wait(ms, signal) {
    assertNotAborted(signal);
    if (!signal)
        return new Promise((resolve) => setTimeout(resolve, ms));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms);
        const onAbort = () => {
            clearTimeout(timer);
            cleanup();
            reject(abortError(signal));
        };
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        function done() {
            cleanup();
            resolve();
        }
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
function leaseDirectory(codexHome) {
    return path.join(path.resolve(codexHome), "ultracode", "global-concurrency");
}
function isLease(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        Number.isInteger(value.pid) &&
        typeof value.hostname === "string" &&
        typeof value.acquired_at === "string");
}
async function readLeases(filePath) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
        if (!isRecord(parsed) || !Array.isArray(parsed.leases))
            return [];
        return parsed.leases.filter(isLease);
    }
    catch (error) {
        if (isRecord(error) && error.code === "ENOENT")
            return [];
        return [];
    }
}
async function writeLeases(filePath, leases) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, `${JSON.stringify({ version: 1, leases })}\n`, "utf8");
        await fs.rename(temporary, filePath);
    }
    finally {
        await fs.rm(temporary, { force: true }).catch(() => { });
    }
}
function pruneLeases(leases) {
    const hostname = os.hostname();
    return leases.filter((lease) => lease.hostname !== hostname || isLivePid(lease.pid));
}
async function pruneOrphanedLock(lockDir) {
    const ownerPath = path.join(lockDir, "owner.json");
    let owner = null;
    try {
        const parsed = JSON.parse(await fs.readFile(ownerPath, "utf8"));
        const pid = isRecord(parsed) ? parsed.pid : null;
        const hostname = isRecord(parsed) ? parsed.hostname : null;
        const createdAt = isRecord(parsed) ? parsed.created_at : null;
        if (isRecord(parsed) &&
            typeof pid === "number" &&
            Number.isInteger(pid) &&
            typeof hostname === "string" &&
            typeof createdAt === "string") {
            owner = {
                pid,
                hostname,
                created_at: createdAt
            };
        }
    }
    catch {
        // A process can only leave an owner-less lock if it died between mkdir and
        // the synchronous owner write below. Treat it as stale only after a grace
        // period so an unusually delayed owner cannot be displaced.
    }
    if (owner && (owner.hostname !== os.hostname() || isLivePid(owner.pid)))
        return;
    if (!owner) {
        try {
            const stat = await fs.stat(lockDir);
            if (Date.now() - stat.mtimeMs < ORPHAN_LOCK_MS)
                return;
        }
        catch {
            return;
        }
    }
    // Rename before removing so two contenders cannot accidentally delete a new
    // lock that another contender created after this stale-owner check.
    const orphaned = `${lockDir}.orphaned-${process.pid}-${crypto.randomUUID()}`;
    try {
        await fs.rename(lockDir, orphaned);
    }
    catch {
        return;
    }
    await fs.rm(orphaned, { recursive: true, force: true }).catch(() => { });
}
async function acquireFileLock(directory, signal) {
    await fs.mkdir(directory, { recursive: true });
    const lockDir = path.join(directory, "leases.lock");
    while (true) {
        assertNotAborted(signal);
        try {
            await fs.mkdir(lockDir);
            try {
                const owner = {
                    pid: process.pid,
                    hostname: os.hostname(),
                    created_at: new Date().toISOString()
                };
                fsSync.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
            }
            catch (error) {
                await fs.rm(lockDir, { recursive: true, force: true }).catch(() => { });
                throw error;
            }
            return async () => {
                await fs.rm(lockDir, { recursive: true, force: true }).catch(() => { });
            };
        }
        catch (error) {
            if (!isAlreadyExists(error))
                throw error;
            await pruneOrphanedLock(lockDir);
            await wait(LOCK_RETRY_MS, signal);
        }
    }
}
async function withFileLock(directory, signal, action) {
    const release = await acquireFileLock(directory, signal);
    try {
        return await action();
    }
    finally {
        await release();
    }
}
function globalConcurrencyDir(codexHome) {
    return leaseDirectory(codexHome);
}
async function acquireGlobalLease(options) {
    const directory = leaseDirectory(options.codexHome);
    const filePath = path.join(directory, "leases.json");
    const limit = Math.max(1, Math.floor(Number(options.limit)) || 1);
    const startedAt = Date.now();
    let announcedWait = false;
    while (true) {
        assertNotAborted(options.signal);
        const decision = await withFileLock(directory, options.signal, async () => {
            const leases = await readLeases(filePath);
            const liveLeases = pruneLeases(leases);
            if (liveLeases.length !== leases.length)
                await writeLeases(filePath, liveLeases);
            if (liveLeases.length >= limit)
                return { granted: false, active: liveLeases.length };
            const lease = {
                id: `${process.pid}-${crypto.randomUUID()}`,
                pid: process.pid,
                hostname: os.hostname(),
                acquired_at: new Date().toISOString()
            };
            const next = [...liveLeases, lease];
            await writeLeases(filePath, next);
            return { granted: true, active: next.length, lease };
        });
        if (decision.granted) {
            let released = false;
            return {
                id: decision.lease.id,
                limit,
                active: decision.active,
                waited_ms: Date.now() - startedAt,
                async release() {
                    if (released)
                        return;
                    released = true;
                    await withFileLock(directory, undefined, async () => {
                        const leases = pruneLeases(await readLeases(filePath));
                        await writeLeases(filePath, leases.filter((lease) => lease.id !== decision.lease.id));
                    });
                }
            };
        }
        if (!announcedWait) {
            announcedWait = true;
            try {
                options.onWait?.({ active: decision.active, limit });
            }
            catch {
                // A progress callback must not affect the concurrency gate.
            }
        }
        await wait(LEASE_RETRY_MS, options.signal);
    }
}
