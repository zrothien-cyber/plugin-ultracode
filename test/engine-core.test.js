"use strict";

const test = require("node:test");
const assert = require("node:assert");

const createFoundation = require("../scripts/engine-foundation.js");
const core = require("../scripts/engine-core.js");

test("foundation delegates stable runtime primitives to the compiled TS core", () => {
  const foundation = createFoundation();
  for (const name of [
    "defaultConcurrency",
    "normalizeConcurrency",
    "createLimiter",
    "emitEvent",
    "log",
    "emptyUsage",
    "addUsageInto",
    "accountUsage",
    "sumUsageFromWorkers",
    "validateAgainstSchema",
    "stableStringify",
    "stepId"
  ]) {
    assert.strictEqual(foundation[name], core[name], `${name} must use the TS implementation`);
  }
  assert.strictEqual(foundation.USAGE_KEYS, core.USAGE_KEYS);

  const context = foundation.createContext({ concurrency: 2, budgetTokens: 20 });
  assert.strictEqual(context.concurrency, 2);
  assert.strictEqual(context.budget.remaining(), 20);
});
