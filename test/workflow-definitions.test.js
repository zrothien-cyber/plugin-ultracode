"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  listWorkflowDefinitions,
  resolveWorkflowDefinition,
  saveWorkflowDefinition
} = require("../scripts/workflow-definitions.js");
const { freshTmpDir } = require("./helpers/env.js");

test("workflow definitions discover project .claude/workflows before user scope", async () => {
  const cwd = freshTmpDir("ultracode-def-cwd-");
  const home = freshTmpDir("ultracode-def-home-");
  const codexHome = freshTmpDir("ultracode-def-codex-");
  fs.mkdirSync(path.join(cwd, ".claude", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "workflows", "audit.js"),
    'export const meta = { name: "Audit", description: "user" }; return { scope: "user" };\n'
  );
  fs.writeFileSync(
    path.join(cwd, ".claude", "workflows", "audit.js"),
    'export const meta = { name: "Audit", description: "project" }; return { scope: "project" };\n'
  );

  const list = await listWorkflowDefinitions({ cwd, home, codex_home: codexHome });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].scope, "project");
  assert.strictEqual(list[0].description, "project");

  const resolved = await resolveWorkflowDefinition("audit", { cwd, home, codex_home: codexHome });
  assert.strictEqual(resolved.scope, "project");
  assert.match(resolved.source, /project/);
});

test("saveWorkflowDefinition writes a project workflow", async () => {
  const cwd = freshTmpDir("ultracode-save-cwd-");
  const saved = await saveWorkflowDefinition({
    cwd,
    name: "Review Bugs",
    source: 'export const meta = { name: "Review Bugs" }; return { ok: true };\n'
  });
  assert.strictEqual(saved.id, "review-bugs");
  assert.strictEqual(saved.scope, "project");
  assert.ok(fs.existsSync(path.join(cwd, ".claude", "workflows", "review-bugs.js")));
});

test("repo Claude workflow examples load as compatible definitions with phase detail", async () => {
  const cwd = path.join(__dirname, "..");
  const list = await listWorkflowDefinitions({ cwd, home: freshTmpDir("ultracode-def-home-"), codex_home: freshTmpDir("ultracode-def-codex-") });
  const audit = list.find((definition) => definition.id === "skill-spirit-audit");
  assert.ok(audit, "local skill-spirit-audit workflow is discovered");
  assert.deepStrictEqual(audit.unsupported, []);
  assert.ok(audit.phases.some((phase) => phase.title === "Lenses" && phase.detail));
});
