"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require("child_process");
function ownCommandLine() {
    return process.argv.filter(Boolean).join(" ");
}
function normalizeCommandLine(commandLine, platform) {
    if (typeof commandLine !== "string" || !commandLine.trim())
        return null;
    const compact = commandLine.replace(/\s+/g, " ").trim();
    return platform === "win32" ? compact.toLowerCase() : compact;
}
function parseWindowsCreationDate(value) {
    if (typeof value !== "string")
        return null;
    const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{3})?$/);
    if (!match)
        return null;
    const [, year, month, day, hour, minute, second, offset] = match;
    const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    if (!offset)
        return new Date(utcMs).toISOString();
    const sign = offset.startsWith("-") ? -1 : 1;
    const offsetMinutes = sign * Number(offset.slice(1));
    return new Date(utcMs - offsetMinutes * 60_000).toISOString();
}
function normalizeStartTime(value) {
    if (typeof value !== "string" || !value.trim())
        return null;
    const parsedWindows = parseWindowsCreationDate(value.trim());
    if (parsedWindows)
        return parsedWindows;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp))
        return null;
    return new Date(timestamp).toISOString();
}
function isLivePid(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (error && error.code === "EPERM")
            return true;
        return false;
    }
}
function runProcessProbe(command, args) {
    return childProcess.execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
        windowsHide: true
    });
}
function lookupWindowsProcessIdentity(pid) {
    const source = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        "if ($null -eq $p) { exit 3 }",
        "$p | Select-Object ProcessId,CreationDate,CommandLine,ExecutablePath | ConvertTo-Json -Compress"
    ].join("; ");
    let parsed;
    try {
        parsed = JSON.parse(runProcessProbe("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", source]).trim());
    }
    catch (error) {
        if (error && error.status === 3)
            return { exists: false, pid, platform: "win32" };
        return { exists: isLivePid(pid), pid, platform: "win32", verified: false, error: error.message };
    }
    return {
        exists: true,
        verified: true,
        pid,
        platform: "win32",
        process_started_at: normalizeStartTime(parsed.CreationDate),
        command_line: parsed.CommandLine || parsed.ExecutablePath || null,
        executable_path: parsed.ExecutablePath || null
    };
}
function lookupPosixProcessIdentity(pid, platform) {
    let output;
    try {
        output = runProcessProbe("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="]);
    }
    catch (error) {
        return { exists: isLivePid(pid), pid, platform, verified: false, error: error.message };
    }
    const trimmed = output.trim();
    if (!trimmed)
        return { exists: false, pid, platform };
    const firstLine = trimmed.split(/\r?\n/, 1)[0];
    const match = firstLine.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/);
    return {
        exists: true,
        verified: true,
        pid,
        platform,
        process_started_at: match ? normalizeStartTime(match[1]) : null,
        command_line: match ? match[2] : trimmed
    };
}
function lookupProcessIdentity(pid, platform = process.platform) {
    if (!Number.isInteger(pid) || pid <= 0)
        return { exists: false, pid, platform };
    if (platform === "win32")
        return lookupWindowsProcessIdentity(pid);
    return lookupPosixProcessIdentity(pid, platform);
}
function currentProcessIdentity(startedAt = null) {
    const observed = lookupProcessIdentity(process.pid);
    const verified = Boolean(observed && observed.verified);
    return {
        pid: process.pid,
        platform: process.platform,
        started_at: startedAt,
        process_started_at: verified && observed.process_started_at ? observed.process_started_at : null,
        command_line: verified && observed.command_line ? observed.command_line : null,
        invocation: ownCommandLine(),
        executable_path: process.execPath
    };
}
function sameCommandLine(expected, observed, platform) {
    const normalizedExpected = normalizeCommandLine(expected, platform);
    const normalizedObserved = normalizeCommandLine(observed, platform);
    return Boolean(normalizedExpected && normalizedObserved && normalizedExpected === normalizedObserved);
}
function sameStartTime(expected, observed) {
    const normalizedExpected = normalizeStartTime(expected);
    const normalizedObserved = normalizeStartTime(observed);
    return Boolean(normalizedExpected && normalizedObserved && normalizedExpected === normalizedObserved);
}
module.exports = {
    currentProcessIdentity,
    isLivePid,
    lookupProcessIdentity,
    normalizeCommandLine,
    normalizeStartTime,
    sameCommandLine,
    sameStartTime
};
