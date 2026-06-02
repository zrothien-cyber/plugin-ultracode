"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  assertClaudeWorkflowSupported,
  extractClaudeWorkflowMeta,
  prepareClaudeWorkflowSource,
  rewriteAllowedWorkflowImports,
  unsupportedClaudeFeatures
} = require("../scripts/claude-workflow-compat.js");

test("extractClaudeWorkflowMeta reads Claude-style export const meta", () => {
  const meta = extractClaudeWorkflowMeta(`
    export const meta = {
      name: "Deep Research",
      description: "Research in phases",
      phases: [{ title: "Scope", detail: "Set bounds" }, "Search"]
    };
    return {};
  `);
  assert.deepStrictEqual(meta, {
    name: "Deep Research",
    description: "Research in phases",
    phases: [{ title: "Scope", detail: "Set bounds" }, { title: "Search" }]
  });
});

test("Claude workflow imports, orchestrator access, and run(context) are supported", () => {
  const source = `
    import { orchestrator } from "claude/workflows";
    export async function run(context) {
      orchestrator.phase("Run");
      return context.args;
    }
  `;
  const unsupported = unsupportedClaudeFeatures(source);
  assert.deepStrictEqual(unsupported, []);
  assert.doesNotThrow(() => assertClaudeWorkflowSupported(source));
  const prepared = prepareClaudeWorkflowSource(source);
  assert.doesNotMatch(prepared, /^\s*import\s+/m);
  assert.match(prepared, /return await run\(context\)/);
});

test("allowed Claude workflow imports preserve aliases and namespaces", () => {
  const prepared = rewriteAllowedWorkflowImports(`
    import runtime, { agent as ask, parallel } from "claude/workflows";
    import * as flow from "claude/workflow";
    const result = await ask("x");
  `);
  assert.match(prepared, /const runtime = orchestrator;/);
  assert.match(prepared, /const ask = agent;/);
  assert.doesNotMatch(prepared, /const parallel = parallel/);
  assert.match(prepared, /const flow = orchestrator;/);
});

test("unsupportedClaudeFeatures rejects direct workflow-side filesystem and shell access", () => {
  const source = `
    import fs from "fs";
    export async function run(context) {
      return context.glob("*.js");
    }
  `;
  const unsupported = unsupportedClaudeFeatures(source);
  assert.ok(unsupported.some((item) => item.includes('import "fs"')));
  assert.ok(unsupported.some((item) => item.includes("context.glob")));
  assert.throws(() => assertClaudeWorkflowSupported(source), /Unsupported Claude workflow syntax/);
});

test("unsupportedClaudeFeatures rejects host globals outside strings/comments", () => {
  const source = `
    // process should not count in comments
    const note = "require('fs') in a prompt is plain text";
    const x = process.env.HOME;
    await import("fs");
  `;
  const unsupported = unsupportedClaudeFeatures(source);
  assert.ok(unsupported.some((item) => item.includes("process")));
  assert.ok(unsupported.some((item) => item.includes("Dynamic import")));
  assert.ok(!unsupported.some((item) => item.includes("CommonJS require")));
});
