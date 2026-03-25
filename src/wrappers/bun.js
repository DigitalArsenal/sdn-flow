import { getWasmEdgeTargetSupport } from "./catalog.js";
import { startWasmEdgeLikeRuntime } from "./runtime.js";

export function describeBunWasmEdgeLikeWrapper() {
  return getWasmEdgeTargetSupport("bun");
}

export async function startBunWasmEdgeLikeRuntime(options = {}) {
  return startWasmEdgeLikeRuntime(options, getWasmEdgeTargetSupport("bun"));
}

export default {
  describeBunWasmEdgeLikeWrapper,
  startBunWasmEdgeLikeRuntime,
};
