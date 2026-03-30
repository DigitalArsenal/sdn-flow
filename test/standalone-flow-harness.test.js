import test from "node:test";
import assert from "node:assert/strict";

import {
  createStandaloneFlowHarness,
  HostedRuntimeAdapter,
  HostedRuntimeEngine,
  RuntimeTarget,
} from "../src/index.js";
import { compileLinkedFlowArtifact } from "../test-support/linkedFlowArtifact.js";

test("createStandaloneFlowHarness enqueues trigger frames and drains a standalone wasmedge runtime", async () => {
  const { artifact } = await compileLinkedFlowArtifact({
    runtimeTargets: [RuntimeTarget.WASMEDGE],
    workingDirectory: "/working/standalone-flow-harness-test",
  });

  const harness = await createStandaloneFlowHarness({
    artifact,
    target: {
      runtimeId: "standalone-flow-harness-runtime",
      hostKind: "wasmedge",
      adapter: HostedRuntimeAdapter.HOST_INTERNAL,
      engine: HostedRuntimeEngine.WASI,
    },
  });

  try {
    const result = await harness.runTriggerFrames([
      {
        typeDescriptorIndex: 0,
        alignment: 8,
        bytes: new Uint8Array([1, 2, 3, 4]),
        streamId: 1,
        sequence: 1,
        traceToken: 1,
      },
    ]);

    assert.equal(harness.target.hostKind, "wasmedge");
    assert.deepEqual(harness.runtimeTargets, [RuntimeTarget.WASMEDGE]);
    assert.equal(result.enqueued, 1);
    assert.equal(result.executions.length, 1);
    assert.equal(result.executions[0].executed, true);
    assert.equal(result.idle, true);
  } finally {
    await harness.close();
  }
});
