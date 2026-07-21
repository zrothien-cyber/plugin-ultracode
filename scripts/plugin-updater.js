"use strict";

const childProcess = require("child_process");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_MARKETPLACE = "zrothien-cyber";

function manifestPathFromHere() {
  return path.join(__dirname, "..", ".codex-plugin", "plugin.json");
}

function parseCodexVersion(version) {
  const parsed = /^(.+)\+codex\.(\d{14})$/.exec(String(version || ""));
  if (!parsed) {
    return {
      version: version || null,
      base_version: version || null,
      cache_buster: null,
      cache_buster_kind: null
    };
  }
  return {
    version,
    base_version: parsed[1],
    cache_buster: parsed[2],
    cache_buster_kind: "codex_timestamp"
  };
}

async function readPluginManifest(manifestPath = manifestPathFromHere()) {
  const raw = await fs.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

function commandErrorMessage(command, args, code, stderr) {
  const detail = stderr && stderr.trim() ? `\n${stderr.trim()}` : "";
  return `${command} ${args.join(" ")} exited ${code}${detail}`;
}

function runCommand(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      // Kill ladder so a hung marketplace can't block forever: SIGTERM, then
      // SIGKILL after a short grace.
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        const hard = setTimeout(() => child.kill("SIGKILL"), 2000);
        if (typeof hard.unref === "function") hard.unref();
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(commandErrorMessage(command, args, code, stderr)));
        return;
      }
      resolve({ command, args, stdout, stderr });
    });
  });
}

function summarizeCommand(result) {
  return {
    command: result.command,
    args: result.args,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function updatePlugin(input = {}) {
  const manifestPath = input.manifest_path || manifestPathFromHere();
  const manifest = await readPluginManifest(manifestPath);
  const plugin = input.plugin || manifest.name;
  if (!plugin) throw new Error("Cannot update plugin: plugin manifest is missing `name`.");

  const marketplace = input.marketplace || process.env.ULTRACODE_MARKETPLACE || DEFAULT_MARKETPLACE;
  const codexBin = input.codex_bin || process.env.ULTRACODE_UPDATE_CODEX_BIN || process.env.CODEX_CLI_PATH || "codex";
  const cwd = input.cwd || process.cwd();
  const env = input.env || process.env;
  const version = parseCodexVersion(manifest.version);

  const timeoutMs = Number.isFinite(Number(input.timeout_ms)) && Number(input.timeout_ms) > 0 ? Number(input.timeout_ms) : 0;
  const upgrade = await runCommand(codexBin, ["plugin", "marketplace", "upgrade", marketplace], { cwd, env, timeoutMs });
  const install = await runCommand(codexBin, ["plugin", "add", `${plugin}@${marketplace}`], { cwd, env, timeoutMs });

  return {
    kind: "plugin_update",
    plugin,
    marketplace,
    codex_bin: codexBin,
    current_version: manifest.version || null,
    current_base_version: version.base_version,
    cache_buster: version.cache_buster,
    cache_buster_kind: version.cache_buster_kind,
    updated_for_future_sessions: true,
    restart_required: true,
    commands: [summarizeCommand(upgrade), summarizeCommand(install)],
    message: `Updated ${plugin}@${marketplace} for future Codex sessions. Start a new Codex thread to load it.`
  };
}

module.exports = {
  DEFAULT_MARKETPLACE,
  parseCodexVersion,
  readPluginManifest,
  updatePlugin
};
