import { startInstalledFlowBrowserFetchHost } from "../../src/index.js";
import { createBootstrapDemoWorkspace } from "./installed-flow-http-demo.js";

export function createBrowserBootstrapWorkspace(options = {}) {
  return createBootstrapDemoWorkspace({
    engine: "browser",
    hostKind: "browser",
    url: options.url ?? "https://app.example/demo",
    ...options,
  });
}

export async function startBrowserBootstrapExample(options = {}) {
  return startInstalledFlowBrowserFetchHost({
    ...options,
    workspace: options.workspace ?? createBrowserBootstrapWorkspace(options),
  });
}

if (
  typeof globalThis.addEventListener === "function" &&
  typeof globalThis.Deno === "undefined" &&
  typeof globalThis.Bun === "undefined" &&
  typeof globalThis.process === "undefined"
) {
  await startBrowserBootstrapExample();
}
