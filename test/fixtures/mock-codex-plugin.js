#!/usr/bin/env node
"use strict";

const fs = require("fs");

const args = process.argv.slice(2);
const logPath = process.env.MOCK_CODEX_PLUGIN_LOG;

if (logPath) {
  fs.appendFileSync(logPath, `${JSON.stringify({ args })}\n`);
}

if (process.env.MOCK_CODEX_PLUGIN_FAIL === args.join(" ")) {
  process.stderr.write(`mock failure for ${args.join(" ")}\n`);
  process.exit(19);
}

// Optional hang, to exercise the updater's wall-clock timeout / kill ladder. A
// setTimeout keeps the process alive and killable by SIGTERM/SIGKILL.
const sleepMs = Number(process.env.MOCK_CODEX_PLUGIN_SLEEP_MS) || 0;

function respond(fn) {
  if (sleepMs > 0) setTimeout(fn, sleepMs);
  else fn();
}

if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "upgrade") {
  respond(() => {
    process.stdout.write(`upgraded ${args[3] || "all"}\n`);
    process.exit(0);
  });
} else if (args[0] === "plugin" && args[1] === "add") {
  respond(() => {
    process.stdout.write(`installed ${args[2]}\n`);
    process.exit(0);
  });
} else {
  process.stderr.write(`unexpected mock codex args: ${args.join(" ")}\n`);
  process.exit(2);
}
