"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  engine,
  MOCK,
  freshSessionDir,
  readInvocations,
  withCodexHome,
  withMockEnv,
  withCodexCliPath
} = require("./helpers/env.js");

const {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  GPT_5_6_MODELS,
  GPT_5_6_REASONING_EFFORTS,
  runPipelineSpec,
  runWorkflow
} = engine;

test("GPT-5.6 Terra with medium reasoning is the default across workflow surfaces", async () => {
  await withCodexHome(async (home) => {
    const fixed = await withMockEnv({}, () =>
      runWorkflow({ task: "default fixed workflow", workers: 1, cwd: home, codex_bin: MOCK, codex_home: home })
    );
    assert.strictEqual(fixed.options.model, DEFAULT_MODEL);
    assert.strictEqual(fixed.options.reasoning_effort, DEFAULT_REASONING_EFFORT);
    assert.strictEqual(fixed.workers[0].model, DEFAULT_MODEL);
    assert.strictEqual(fixed.workers[0].reasoning_effort, DEFAULT_REASONING_EFFORT);

    const panel = await withMockEnv({}, () =>
      runWorkflow({ cwd: home, codex_bin: MOCK, codex_home: home, workers_spec: [{ prompt: "default panel" }] })
    );
    assert.strictEqual(panel.options.model, DEFAULT_MODEL);
    assert.strictEqual(panel.options.reasoning_effort, DEFAULT_REASONING_EFFORT);
    assert.strictEqual(panel.workers[0].model, DEFAULT_MODEL);
    assert.strictEqual(panel.workers[0].reasoning_effort, DEFAULT_REASONING_EFFORT);

    const dag = await withCodexCliPath(MOCK, () =>
      withMockEnv({}, () =>
        runPipelineSpec({ cwd: home, codex_bin: MOCK, codex_home: home, steps: [{ id: "default", prompt: "default DAG" }] })
      )
    );
    assert.strictEqual(dag.options.model, DEFAULT_MODEL);
    assert.strictEqual(dag.options.reasoning_effort, DEFAULT_REASONING_EFFORT);
    assert.strictEqual(dag.steps[0].model, DEFAULT_MODEL);
    assert.strictEqual(dag.steps[0].reasoning_effort, DEFAULT_REASONING_EFFORT);
  });
});

test("GPT-5.6 models and their supported reasoning efforts are accepted and journaled", async () => {
  await withCodexHome(async (home) => {
    const sessionDir = freshSessionDir();
    const workers_spec = GPT_5_6_MODELS.flatMap((model) =>
      GPT_5_6_REASONING_EFFORTS.map((reasoning_effort) => ({
        label: `${model}-${reasoning_effort}`,
        prompt: `exercise ${model} at ${reasoning_effort}`,
        model,
        reasoning_effort
      }))
    );

    const workflow = await withMockEnv({ MOCK_CODEX_SESSION_DIR: sessionDir }, () =>
      runWorkflow({
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        concurrency: workers_spec.length,
        workers_spec
      })
    );

    assert.strictEqual(workflow.status, "completed");
    assert.strictEqual(workflow.workers.length, workers_spec.length);
    const invocations = readInvocations(sessionDir);
    assert.strictEqual(invocations.length, workers_spec.length);
    for (const model of GPT_5_6_MODELS) {
      for (const reasoning_effort of GPT_5_6_REASONING_EFFORTS) {
        assert.ok(
          workflow.workers.some((worker) => worker.model === model && worker.reasoning_effort === reasoning_effort),
          `expected ${model} with ${reasoning_effort} to be preserved`
        );
        assert.ok(
          invocations.some(
            ({ argv }) =>
              argv.includes(model) && argv.includes(`model_reasoning_effort=${JSON.stringify(reasoning_effort)}`)
          ),
          `expected ${model} with ${reasoning_effort} to be passed to Codex`
        );
      }
    }
  });
});

test("GPT-5.6 reasoning efforts flow through fixed and DAG workflow paths", async () => {
  await withCodexHome(async (home) => {
    const fixed = await withMockEnv({}, () =>
      runWorkflow({
        task: "fixed workflow GPT-5.6 contract",
        workers: 1,
        cwd: home,
        codex_bin: MOCK,
        codex_home: home,
        model: "gpt-5.6-sol",
        reasoning_effort: "ultra"
      })
    );
    assert.strictEqual(fixed.workers[0].model, "gpt-5.6-sol");
    assert.strictEqual(fixed.workers[0].reasoning_effort, "ultra");

    const dag = await withCodexCliPath(MOCK, () =>
      withMockEnv({}, () =>
        runPipelineSpec({
          cwd: home,
          codex_bin: MOCK,
          codex_home: home,
          steps: [{ id: "fast", prompt: "DAG GPT-5.6 contract", model: "gpt-5.6-luna", reasoning_effort: "none" }]
        })
      )
    );
    assert.strictEqual(dag.steps[0].model, "gpt-5.6-luna");
    assert.strictEqual(dag.steps[0].reasoning_effort, "none");
  });
});
