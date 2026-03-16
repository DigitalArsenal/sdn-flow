#!/usr/bin/env node

import path from "node:path";
import process from "node:process";

import {
  loadManifestFromFile,
  loadComplianceConfig,
  resolveManifestFiles,
  validatePluginArtifact,
  validatePluginManifest,
} from "../src/compliance/index.js";

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }

  const reports = [];
  if (options.manifests.length > 0) {
    for (const manifestPath of options.manifests) {
      const manifest = await loadManifestFromFile(manifestPath);
      if (options.wasmPath) {
        reports.push(
          await validatePluginArtifact({
            manifest,
            manifestPath,
            wasmPath: options.wasmPath,
          }),
        );
      } else {
        reports.push(validatePluginManifest(manifest, { sourceName: manifestPath }));
      }
    }
  } else {
    const repoRoot = path.resolve(options.repoRoot);
    const loadedConfig = await loadComplianceConfig(repoRoot);
    const manifestPaths = await resolveManifestFiles(repoRoot);
    if (manifestPaths.length === 0) {
      if (loadedConfig?.config?.allowEmpty === true) {
        if (!options.json) {
          console.log(`No manifests configured under ${repoRoot}; allowEmpty=true so the check passes.`);
        }
        return 0;
      }
      if (loadedConfig) {
        console.error(`No manifest.json files matched ${loadedConfig.path}`);
      } else {
        console.error(`No manifest.json files found under ${repoRoot}`);
      }
      return 1;
    }
    for (const manifestPath of manifestPaths) {
      const manifest = await loadManifestFromFile(manifestPath);
      reports.push(validatePluginManifest(manifest, { sourceName: manifestPath }));
    }
  }

  if (options.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    printReports(reports);
  }

  return reports.every((report) => report.ok) ? 0 : 1;
}

function parseArgs(argv) {
  const options = {
    help: false,
    json: false,
    repoRoot: process.cwd(),
    manifests: [],
    wasmPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--repo-root":
        options.repoRoot = requireValue(argv, ++index, "--repo-root");
        break;
      case "--manifest":
        options.manifests.push(path.resolve(requireValue(argv, ++index, "--manifest")));
        break;
      case "--wasm":
        options.wasmPath = path.resolve(requireValue(argv, ++index, "--wasm"));
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  return options;
}

function requireValue(argv, index, flagName) {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flagName} requires a value.`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node tools/run-plugin-compliance-check.mjs --repo-root .
  node tools/run-plugin-compliance-check.mjs --manifest ./manifest.json
  node tools/run-plugin-compliance-check.mjs --manifest ./manifest.json --wasm ./dist/plugin.wasm

Options:
  --repo-root <path>  Scan a repository for manifest.json files and validate them.
                      If sdn-plugin-compliance.json exists, its scan targets are used.
  --manifest <path>   Validate one or more specific manifest.json files.
  --wasm <path>       Also validate plugin ABI export symbols from a compiled wasm artifact.
  --json              Emit JSON instead of human-readable text.
  --help              Show this help text.`);
}

function printReports(reports) {
  for (const report of reports) {
    const status = report.ok ? "PASS" : "FAIL";
    const artifactMode = report.checkedArtifact ? "manifest+abi" : "manifest";
    console.log(`${status} ${report.sourceName} [${artifactMode}]`);
    for (const issue of report.issues) {
      console.log(`  ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
      if (issue.location) {
        console.log(`    at ${issue.location}`);
      }
    }
    if (report.issues.length === 0) {
      console.log("  No issues found.");
    }
  }
}

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
