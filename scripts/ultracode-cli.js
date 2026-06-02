#!/usr/bin/env node
"use strict";

const engine = require("./ultracode-engine");
const fs = require("fs/promises");
// Require the runner DIRECTLY (not via engine) to keep the script contract
// clean and cycle-free (the runner requires the engine; the engine never
// top-level-requires the runner).
const scriptRunner = require("./ultracode-script-runner");
const workflowDefinitions = require("./workflow-definitions");

const NUMERIC_KEYS = new Set([
  "workers",
  "timeout_ms",
  "concurrency",
  "budget_tokens",
  "max_agents",
  "launch_stagger_ms",
  "max_retries",
  "base_delay_ms",
  "max_delay_ms",
  "ui_port"
]);
const JSON_KEYS = new Set(["workers_spec", "force_steps", "steps", "args"]);
const BOOLEAN_KEYS = new Set(["ui", "retry_jitter", "transport_strict"]);
const UI_COMMANDS = new Set(["run", "pipeline", "resume", "script", "workflow"]);

function parseBool(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  if (["1", "true", "yes", "on", "enabled", ""].includes(normalized)) return true;
  return true;
}

function parseArgs(argv) {
  const [command = "plan", ...rest] = argv;
  const options = {};
  let index = 0;
  // A single leading positional (before any --flag) is collected as
  // options._positional. Existing commands never pass one, so their parse is
  // byte-identical; the `script` command maps it to a script `path`.
  if (rest.length > 0 && !rest[0].startsWith("--")) {
    options._positional = rest[0];
    options._positionals = [rest[0]];
    index = 1;
  }
  for (; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      if (!options._positionals) options._positionals = [];
      options._positionals.push(arg);
      if (options._positional === undefined) options._positional = arg;
      continue;
    }
    const key = arg.slice(2).replace(/-/g, "_");
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { command, options };
}

function coerce(options, command) {
  for (const key of NUMERIC_KEYS) {
    if (typeof options[key] === "string") {
      const number = Number(options[key]);
      if (Number.isFinite(number)) options[key] = number;
    }
  }
  for (const key of JSON_KEYS) {
    if (typeof options[key] === "string") {
      try {
        options[key] = JSON.parse(options[key]);
      } catch (error) {
        throw new Error(`--${key} must be valid JSON: ${error.message}`);
      }
    }
  }
  if (options.no_ui) {
    options.ui = false;
    delete options.no_ui;
  }
  for (const key of BOOLEAN_KEYS) {
    if (key in options) {
      options[key] = parseBool(options[key]);
    }
  }
  if (UI_COMMANDS.has(command) && options.ui === undefined) {
    const env = parseBool(process.env.ULTRACODE_UI);
    options.ui = env === undefined ? true : env;
  }
  if (options.progress) {
    options.on_event = (event) => {
      process.stderr.write(`[ultracode] ${event.type}${event.label ? ` ${event.label}` : ""}${event.message ? ` ${event.message}` : ""}\n`);
    };
    delete options.progress;
  }
  return options;
}

// Run an engine call that supports cancellation, wiring a one-shot SIGINT
// handler that aborts the in-flight run on the first Ctrl-C (the engine then
// returns the partially-completed, persisted workflow which main() prints) and
// hard-exits 130 on a second SIGINT. The handler is scoped to the awaited call
// and removed afterwards so it never swallows Ctrl-C for plan/status. Opt out
// with --no-cancel-on-sigint.
async function runCancellable(fn, options) {
  if (options.no_cancel_on_sigint || process.env.ULTRACODE_NO_SIGINT) {
    return fn(options);
  }
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write("\n[ultracode] cancelling run (Ctrl-C again to force quit)...\n");
      controller.abort("SIGINT");
    } else {
      process.stderr.write("\n[ultracode] force quit.\n");
      process.exit(130);
    }
  };
  process.on("SIGINT", onSigint);
  try {
    return await fn({ ...options, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function workflowCommand(options) {
  const positionals = Array.isArray(options._positionals) ? options._positionals : [];
  const action = positionals[0] || "list";
  const target = positionals[1] || options.name || options.workflow;
  const common = {
    cwd: options.cwd,
    codex_home: options.codex_home
  };
  if (action === "list") {
    return { kind: "workflow_definitions", workflows: await workflowDefinitions.listWorkflowDefinitions(common) };
  }
  if (action === "show") {
    const definition = await workflowDefinitions.resolveWorkflowDefinition(target, common);
    return {
      kind: "workflow_definition",
      ...definition
    };
  }
  if (action === "run") {
    const definition = await workflowDefinitions.resolveWorkflowDefinition(target, common);
    const runOptions = {
      ...options,
      path: definition.path,
      name: options.run_name || options.name || definition.name,
      claude_compat: true,
      definition_ref: {
        id: definition.id,
        name: definition.name,
        scope: definition.scope,
        path: definition.path,
        source_hash: definition.source_hash
      }
    };
    delete runOptions._positional;
    delete runOptions._positionals;
    delete runOptions.workflow;
    return runCancellable(scriptRunner.runScript, runOptions);
  }
  if (action === "save") {
    let source = options.source;
    if (!source && options.source_path) source = await fs.readFile(options.source_path, "utf8");
    if (!source && (options.workflow_id || options.state_path || options.from_workflow_id)) {
      const record = await engine.readWorkflow({
        workflow_id: options.from_workflow_id || options.workflow_id,
        state_path: options.state_path
      });
      if (!record || record.status === "missing") throw new Error("No workflow record found to save.");
      const scriptPath = record.script_path || record.source_path;
      if (!scriptPath) throw new Error("Workflow record does not include a script_path or source_path.");
      source = await fs.readFile(scriptPath, "utf8");
    }
    const saved = await workflowDefinitions.saveWorkflowDefinition({
      name: target,
      source,
      cwd: options.cwd,
      codex_home: options.codex_home,
      scope: options.scope || "project"
    });
    return {
      kind: "workflow_definition",
      saved: true,
      ...saved
    };
  }
  if (action === "update") {
    let source = options.source;
    if (!source && options.source_path) source = await fs.readFile(options.source_path, "utf8");
    const updated = await workflowDefinitions.updateWorkflowDefinition(target, {
      ...common,
      source
    });
    return {
      kind: "workflow_definition",
      saved: true,
      ...updated
    };
  }
  if (action === "delete" || action === "rm") {
    const deleted = await workflowDefinitions.deleteWorkflowDefinition(target, common);
    return {
      kind: "workflow_definition",
      deleted: true,
      ...deleted
    };
  }
  throw new Error(`Unknown workflow command: ${action} (expected list|show|run|save|update|delete)`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  coerce(options, command);
  const positionals = Array.isArray(options._positionals) ? options._positionals : [];
  if (command !== "workflow" && command !== "script" && positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  if (command === "script" && positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  let result;
  if (command === "plan") {
    result = engine.planWorkflow(options);
  } else if (command === "run") {
    result = await runCancellable(engine.runWorkflow, options);
  } else if (command === "pipeline") {
    result = await runCancellable(engine.runPipelineSpec, options);
  } else if (command === "resume") {
    result = await runCancellable(engine.resumeWorkflow, options);
  } else if (command === "status") {
    result = await engine.readWorkflow(options);
  } else if (command === "script") {
    // Accept a positional <path>, or --path / --source (--args is JSON).
    if (options._positional !== undefined && options.path === undefined) {
      options.path = options._positional;
    }
    delete options._positional;
    delete options._positionals;
    result = await runCancellable(scriptRunner.runScript, options);
  } else if (command === "workflow") {
    result = await workflowCommand(options);
  } else {
    throw new Error(`Unknown command: ${command} (expected plan|run|pipeline|resume|status|script|workflow)`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
