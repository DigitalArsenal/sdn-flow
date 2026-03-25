import { getWasmEdgeTargetSupport } from "./catalog.js";
import { startWasmEdgeLikeRuntime } from "./runtime.js";

export function describeDenoWasmEdgeLikeWrapper() {
  return getWasmEdgeTargetSupport("deno");
}

export async function startDenoWasmEdgeLikeRuntime(options = {}) {
  return startWasmEdgeLikeRuntime(options, getWasmEdgeTargetSupport("deno"));
}

export default {
  describeDenoWasmEdgeLikeWrapper,
  startDenoWasmEdgeLikeRuntime,
};
