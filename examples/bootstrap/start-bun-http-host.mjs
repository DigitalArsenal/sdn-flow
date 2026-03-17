import { startInstalledFlowBunHttpHost } from "../../src/index.js";
import { createBootstrapDemoWorkspace } from "./installed-flow-http-demo.js";

export function createBunBootstrapWorkspace(options = {}) {
  return createBootstrapDemoWorkspace({
    engine: "bun",
    url: options.url ?? "http://127.0.0.1:9080/demo",
    ...options,
  });
}

export async function startBunBootstrapExample(options = {}) {
  return startInstalledFlowBunHttpHost({
    ...options,
    workspace: options.workspace ?? createBunBootstrapWorkspace(options),
  });
}

if (typeof globalThis.Bun !== "undefined" && import.meta.main) {
  await startBunBootstrapExample();
}
