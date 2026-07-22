"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { engine, freshCounterPath, freshTmpDir, mockOpts, withMockEnv } = require("./helpers/env.js");
const { createContext, spawnWorker } = engine;
const { acquireGlobalLease, globalConcurrencyDir } = require("../scripts/global-concurrency.js");

test("global concurrency spans independent run contexts and releases every lease", async () => {
  const codexHome = freshTmpDir("ultracode-global-home-");
  const counter = freshCounterPath();
  const events = [];
  const contexts = Array.from({ length: 3 }, () =>
    createContext({ concurrency: 1, globalConcurrency: 1, onEvent: (event) => events.push(event) })
  );
  const startedAt = Date.now();

  const results = await withMockEnv(
    {
      MOCK_CODEX_COUNTER: counter,
      MOCK_CODEX_SLEEP_MS: "180"
    },
    async () =>
      Promise.all(
        contexts.map((ctx, index) =>
          spawnWorker(`prompt ${index}`, {
            ...mockOpts({ codex_home: codexHome, timeoutMs: 5_000 }),
            ctx
          })
        )
      )
  );

  assert.ok(results.every((result) => result.status === "completed"));
  assert.ok(Date.now() - startedAt >= 400, "three 180ms workers are serialized by the shared global slot");
  assert.ok(events.filter((event) => event.type === "worker.global_wait").length >= 2, "waiting is journaled");

  const leasesPath = path.join(codexHome, "ultracode", "global-concurrency", "leases.json");
  const leases = JSON.parse(fs.readFileSync(leasesPath, "utf8"));
  assert.deepStrictEqual(leases.leases, [], "each completed worker releases its global lease");
});

test("dead leases and stale lock owners are reclaimed before admission", async () => {
  const codexHome = freshTmpDir("ultracode-global-recovery-");
  const directory = globalConcurrencyDir(codexHome);
  const lockDir = path.join(directory, "leases.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "owner.json"),
    JSON.stringify({ pid: 999_999_999, hostname: os.hostname(), created_at: new Date().toISOString() })
  );
  fs.writeFileSync(
    path.join(directory, "leases.json"),
    JSON.stringify({
      version: 1,
      leases: [
        { id: "dead", pid: 999_999_999, hostname: os.hostname(), acquired_at: new Date().toISOString() }
      ]
    })
  );

  const lease = await acquireGlobalLease({ codexHome, limit: 1 });
  assert.strictEqual(lease.active, 1, "the dead lease does not consume the only slot");
  await lease.release();
  const saved = JSON.parse(fs.readFileSync(path.join(directory, "leases.json"), "utf8"));
  assert.deepStrictEqual(saved.leases, []);
});
