import { startInstalledFlowDenoHttpHost } from "../../src/index.js";
import { createBootstrapDemoWorkspace } from "./installed-flow-http-demo.js";

export function createDenoBootstrapWorkspace(options = {}) {
  return createBootstrapDemoWorkspace({
    engine: "deno",
    url: options.url ?? "http://127.0.0.1:9080/demo",
    ...options,
  });
}

export async function startDenoBootstrapExample(options = {}) {
  return startInstalledFlowDenoHttpHost({
    ...options,
    workspace: options.workspace ?? createDenoBootstrapWorkspace(options),
  });
}

if (typeof globalThis.Deno !== "undefined" && import.meta.main) {
  await startDenoBootstrapExample();
}
