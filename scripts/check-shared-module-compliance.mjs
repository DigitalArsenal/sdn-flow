#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);

function resolveInstalledModuleSdkBin() {
  try {
    const entryPath = require.resolve("space-data-module-sdk");
    const packageRoot = path.resolve(path.dirname(entryPath), "..");
    const candidate = path.join(packageRoot, "bin", "space-data-module.js");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveSharedModuleSdkBin() {
  const installed = resolveInstalledModuleSdkBin();
  if (installed) {
    return installed;
  }

  const rootCandidates = [
    process.env.SPACE_DATA_MODULE_SDK_ROOT,
    path.resolve(repoRoot, "../space-data-module-sdk"),
  ].filter(Boolean);

  for (const root of rootCandidates) {
    const candidates = [
      path.resolve(root, "bin/space-data-module.js"),
      path.resolve(root, "packages/module-sdk/bin/space-data-module.js"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    "Unable to locate space-data-module-sdk. Install dependencies, clone it next to sdn-flow, or set SPACE_DATA_MODULE_SDK_ROOT.",
  );
}

const toolPath = resolveSharedModuleSdkBin();
const result = spawnSync(
  process.execPath,
  [toolPath, "check", "--repo-root", repoRoot, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

process.exit(result.status ?? 1);
