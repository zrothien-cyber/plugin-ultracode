#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function main() {
  if (process.env.ULTRACODE_CHILD === "1") {
    return;
  }

  let input;
  try {
    input = JSON.parse(readStdin() || "{}");
  } catch {
    return;
  }

  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!/\bultracode\b/i.test(prompt)) {
    return;
  }

  const pluginRoot = path.resolve(__dirname, "..");
  const cliPath = path.join(pluginRoot, "scripts", "ultracode-cli.js");
  const cliCommand = `node ${JSON.stringify(cliPath)}`;

  process.stdout.write(
    JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext:
          `Ultracode is available through its CLI. Use \`${cliCommand} plan|run|pipeline|resume|status|script\` ` +
          "from the shell when a parallel worker pass earns its overhead (breadth or independent verification, " +
          "not raw speed); skip it for small/local work. Scale worker count and verification depth to the request. " +
          "Default to barrier-free staging (`pipeline` DAGs, or `script` for imperative control flow), keep workers " +
          "read-only, and verify findings adversarially (skeptics prompted to refute) before acting on them. " +
          "See the ultracode SKILL for the quality patterns. Then synthesize and implement in the parent thread so " +
          "important edits remain visible."
      }
    })
  );
}

main();
