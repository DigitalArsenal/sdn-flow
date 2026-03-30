import test from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";

import {
  ensureNativeFlowSourceGeneratorTool,
  getNativeFlowSourceGeneratorToolInfo,
} from "../src/compiler/index.js";

test("native flow source generator tool resolves non-empty generated artifacts", async () => {
  const info = getNativeFlowSourceGeneratorToolInfo();
  const ensured = await ensureNativeFlowSourceGeneratorTool();

  assert.equal(ensured.modulePath, info.modulePath);
  assert.equal(ensured.wasmPath, info.wasmPath);
  assert.ok(statSync(ensured.modulePath).size > 0);
  assert.ok(statSync(ensured.wasmPath).size > 0);
});
