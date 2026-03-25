import { getWasmEdgeTargetSupport } from "./catalog.js";
import { startWasmEdgeLikeRuntime } from "./runtime.js";

export function describeBrowserWasmEdgeLikeWrapper() {
  return getWasmEdgeTargetSupport("browser");
}

export async function startBrowserWasmEdgeLikeRuntime(options = {}) {
  return startWasmEdgeLikeRuntime(
    options,
    getWasmEdgeTargetSupport("browser"),
  );
}

export default {
  describeBrowserWasmEdgeLikeWrapper,
  startBrowserWasmEdgeLikeRuntime,
};
