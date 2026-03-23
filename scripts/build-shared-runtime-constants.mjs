import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as runtimeConstantsModule from "space-data-module-sdk/runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const outputPath = path.join(
  repoRoot,
  "src/generated/sharedRuntimeConstants.generated.js",
);

function renderFrozenExport(name, value) {
  return `export const ${name} = Object.freeze(${JSON.stringify(value, null, 2)});\n`;
}

const output =
  `// Auto-generated from space-data-module-sdk/runtime - DO NOT EDIT.\n\n` +
  renderFrozenExport("DrainPolicy", runtimeConstantsModule.DrainPolicy) +
  `\n` +
  renderFrozenExport(
    "ExternalInterfaceDirection",
    runtimeConstantsModule.ExternalInterfaceDirection,
  ) +
  `\n` +
  renderFrozenExport("ExternalInterfaceKind", runtimeConstantsModule.ExternalInterfaceKind) +
  `\n` +
  renderFrozenExport("RuntimeTarget", runtimeConstantsModule.RuntimeTarget) +
  `\n` +
  renderFrozenExport("InvokeSurface", runtimeConstantsModule.InvokeSurface) +
  `\n` +
  renderFrozenExport(
    "DefaultManifestExports",
    runtimeConstantsModule.DefaultManifestExports,
  ) +
  `\n` +
  renderFrozenExport(
    "DefaultInvokeExports",
    runtimeConstantsModule.DefaultInvokeExports,
  ) +
  `\n` +
  `export default {\n` +
  `  DrainPolicy,\n` +
  `  ExternalInterfaceDirection,\n` +
  `  ExternalInterfaceKind,\n` +
  `  RuntimeTarget,\n` +
  `  InvokeSurface,\n` +
  `  DefaultManifestExports,\n` +
  `  DefaultInvokeExports,\n` +
  `};\n`;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, output, "utf8");
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
