import { startInstalledFlowAutoHost } from "../../src/index.js";

export const AutoBootstrapWorkspacePath = new URL(
  "../environments/sdn-js-catalog-gateway/workspace.json",
  import.meta.url,
).pathname;

export async function startAutoBootstrapExample(options = {}) {
  return startInstalledFlowAutoHost({
    ...options,
    workspacePath: options.workspacePath ?? AutoBootstrapWorkspacePath,
  });
}

if (
  (typeof globalThis.Deno !== "undefined" || typeof globalThis.Bun !== "undefined") &&
  import.meta.main
) {
  await startAutoBootstrapExample();
}
