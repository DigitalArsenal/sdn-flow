import path from "node:path";
import { fileURLToPath } from "node:url";

import { startInstalledFlowNodeHttpHost } from "../../src/index.js";
import { createBootstrapDemoWorkspace } from "./installed-flow-http-demo.js";

export function createNodeBootstrapWorkspace(options = {}) {
  return createBootstrapDemoWorkspace({
    engine: "node",
    url: options.url ?? "http://127.0.0.1:9080/demo",
    ...options,
  });
}

export async function startNodeBootstrapExample(options = {}) {
  return startInstalledFlowNodeHttpHost({
    ...options,
    workspace: options.workspace ?? createNodeBootstrapWorkspace(options),
  });
}

const isNodeMain =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isNodeMain) {
  await startNodeBootstrapExample();
}
