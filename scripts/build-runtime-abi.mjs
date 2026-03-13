#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const SCHEMA_PATH = join(ROOT, "schemas", "FlowRuntimeAbi.fbs");
const OUTPUT_PATH = join(ROOT, "src", "generated", "runtimeAbiLayouts.js");

const SCALAR_TYPES = new Map([
  ["bool", { size: 1, alignment: 1 }],
  ["byte", { size: 1, alignment: 1 }],
  ["ubyte", { size: 1, alignment: 1 }],
  ["int8", { size: 1, alignment: 1 }],
  ["uint8", { size: 1, alignment: 1 }],
  ["short", { size: 2, alignment: 2 }],
  ["ushort", { size: 2, alignment: 2 }],
  ["int16", { size: 2, alignment: 2 }],
  ["uint16", { size: 2, alignment: 2 }],
  ["int", { size: 4, alignment: 4 }],
  ["uint", { size: 4, alignment: 4 }],
  ["int32", { size: 4, alignment: 4 }],
  ["uint32", { size: 4, alignment: 4 }],
  ["float", { size: 4, alignment: 4 }],
  ["long", { size: 8, alignment: 8 }],
  ["ulong", { size: 8, alignment: 8 }],
  ["int64", { size: 8, alignment: 8 }],
  ["uint64", { size: 8, alignment: 8 }],
  ["double", { size: 8, alignment: 8 }],
]);

function stripComments(text) {
  return text
    .replace(/\/\/\/.*$/gm, "")
    .replace(/\/\/.*$/gm, "")
    .trim();
}

function alignTo(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function toCamelCase(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function parseStructs(schemaText) {
  const structs = [];
  const clean = stripComments(schemaText);
  const structRegex = /struct\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let match;
  while ((match = structRegex.exec(clean)) !== null) {
    const [, name, body] = match;
    const fields = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const fieldMatch = line.match(/^(\w+)\s*:\s*([A-Za-z0-9_]+)\s*;/);
      if (!fieldMatch) {
        throw new Error(`Unsupported struct field syntax: ${line}`);
      }
      const [, fieldName, fieldType] = fieldMatch;
      const scalar = SCALAR_TYPES.get(fieldType);
      if (!scalar) {
        throw new Error(
          `Unsupported FlowRuntimeAbi scalar type "${fieldType}" for ${name}.${fieldName}`,
        );
      }
      fields.push({
        schemaField: fieldName,
        propertyName: toCamelCase(fieldName),
        type: fieldType,
        size: scalar.size,
        alignment: scalar.alignment,
      });
    }
    structs.push({ name, fields });
  }
  return structs;
}

export function computeLayout(structDef) {
  let size = 0;
  let maxAlignment = 1;
  const fields = [];
  for (const field of structDef.fields) {
    size = alignTo(size, field.alignment);
    fields.push({
      ...field,
      offset: size,
    });
    size += field.size;
    maxAlignment = Math.max(maxAlignment, field.alignment);
  }
  return {
    name: structDef.name,
    size: alignTo(size, maxAlignment),
    alignment: maxAlignment,
    fields,
  };
}

function renderLayout(layout) {
  const fieldEntries = layout.fields
    .map(
      (field) => `    ${field.propertyName}: Object.freeze({
      schemaField: "${field.schemaField}",
      offset: ${field.offset},
      size: ${field.size},
      alignment: ${field.alignment},
      scalarType: "${field.type}",
    }),`,
    )
    .join("\n");
  const offsetEntries = layout.fields
    .map(
      (field) =>
        `  ${field.propertyName}Offset: ${field.offset},`,
    )
    .join("\n");
  return `export const ${layout.name}Layout = Object.freeze({
  schema: "sdn.flow.abi.${layout.name}",
  schemaPath: "schemas/FlowRuntimeAbi.fbs",
  size: ${layout.size},
  alignment: ${layout.alignment},
${offsetEntries}
  fields: Object.freeze({
${fieldEntries}
  }),
});
`;
}

export async function generateRuntimeAbiLayoutsSource() {
  const schemaText = await readFile(SCHEMA_PATH, "utf8");
  const layouts = parseStructs(schemaText).map(computeLayout);
  return `// Auto-generated from schemas/FlowRuntimeAbi.fbs - DO NOT EDIT.

${layouts.map(renderLayout).join("\n")}
export const RuntimeAbiLayouts = Object.freeze({
${layouts.map((layout) => `  ${layout.name}: ${layout.name}Layout,`).join("\n")}
});
`;
}

export async function writeRuntimeAbiLayouts() {
  const output = await generateRuntimeAbiLayoutsSource();
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, output);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeRuntimeAbiLayouts();
}
