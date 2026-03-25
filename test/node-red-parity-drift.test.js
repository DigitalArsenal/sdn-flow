import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { NodeRedNodeSets } from "../src/editor/nodeRedRegistry.generated.js";
import { EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILIES } from "../src/editor/liveRuntimeSupport.js";

const MATRIX_PATH = new URL("../docs/node-red-parity-matrix.md", import.meta.url);
const RUNTIME_MANAGER_PATH = new URL("../src/editor/runtimeManager.js", import.meta.url);
const FLOW_LOWERING_PATH = new URL("../src/editor/flowLowering.js", import.meta.url);

const NON_MATRIX_NODE_TYPES = new Set([
  "tls-config",
  "mqtt-broker",
  "http proxy",
  "global-config",
  "unknown",
]);

const RUNTIME_HANDLER_KEYS = new Map([
  ["function", "com.digitalarsenal.editor.function:invoke"],
  ["change", "com.digitalarsenal.editor.change:invoke"],
  ["switch", "com.digitalarsenal.editor.switch:route"],
  ["range", "com.digitalarsenal.editor.range:invoke"],
  ["template", "com.digitalarsenal.editor.template:invoke"],
  ["json", "com.digitalarsenal.editor.json:invoke"],
  ["csv", "com.digitalarsenal.editor.csv:invoke"],
  ["yaml", "com.digitalarsenal.editor.yaml:invoke"],
  ["xml", "com.digitalarsenal.editor.xml:invoke"],
  ["html", "com.digitalarsenal.editor.html:invoke"],
  ["split", "com.digitalarsenal.editor.split:invoke"],
  ["join", "com.digitalarsenal.editor.join:invoke"],
  ["batch", "com.digitalarsenal.editor.batch:invoke"],
  ["sort", "com.digitalarsenal.editor.sort:invoke"],
  ["file", "com.digitalarsenal.editor.file:invoke"],
  ["file in", "com.digitalarsenal.editor.file-in:invoke"],
  ["debug", "com.digitalarsenal.editor.debug:write_debug"],
  ["http request", "com.digitalarsenal.flow.http-fetcher:fetch"],
  ["http response", "com.digitalarsenal.flow.http-response:send"],
  ["delay", "com.digitalarsenal.editor.delay:invoke"],
  ["trigger", "com.digitalarsenal.editor.trigger:invoke"],
  ["exec", "com.digitalarsenal.editor.exec:invoke"],
  ["link in", "com.digitalarsenal.editor.link-in:invoke"],
  ["link out", "com.digitalarsenal.editor.link-out:invoke"],
  ["link call", "com.digitalarsenal.editor.link-call:invoke"],
]);

const DELEGATED_WRAPPER_FAMILIES = new Set([
  "file",
  "file in",
  "debug",
  "http request",
  "http response",
  "delay",
  "trigger",
  "exec",
  "link in",
  "link out",
  "link call",
]);

function parseMatrixRows(text) {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.startsWith("| ") &&
        !line.includes("| ---") &&
        !line.includes("| Family |"),
    )
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      return {
        families: cells[0],
        targetBucket: cells[1],
        currentState: cells[2],
        evidence: cells[3],
      };
    });
}

function splitFamilies(cell) {
  return cell
    .split(",")
    .map((entry) => entry.replace(/`/g, "").trim())
    .filter(Boolean);
}

function collectShippedFamilies() {
  const families = new Set();
  for (const nodeSet of NodeRedNodeSets) {
    for (const type of nodeSet.types ?? []) {
      if (!NON_MATRIX_NODE_TYPES.has(type)) {
        families.add(type);
      }
    }
  }
  return families;
}

test("parity matrix covers the shipped default node families", async () => {
  const [matrixText] = await Promise.all([
    fs.readFile(MATRIX_PATH, "utf8"),
  ]);
  const matrixRows = parseMatrixRows(matrixText);
  const matrixFamilies = new Set(matrixRows.flatMap((row) => splitFamilies(row.families)));
  const shippedFamilies = collectShippedFamilies();

  assert.deepEqual(
    [...matrixFamilies].sort(),
    [...shippedFamilies].sort(),
    "The checked-in parity matrix no longer matches the shipped default palette.",
  );
});

test("parity matrix current-state claims match the runtime support we ship", async () => {
  const [matrixText, runtimeManagerSource, flowLoweringSource] = await Promise.all([
    fs.readFile(MATRIX_PATH, "utf8"),
    fs.readFile(RUNTIME_MANAGER_PATH, "utf8"),
    fs.readFile(FLOW_LOWERING_PATH, "utf8"),
  ]);

  const matrixRows = parseMatrixRows(matrixText);
  const rowsByFamily = new Map();
  for (const row of matrixRows) {
    for (const family of splitFamilies(row.families)) {
      rowsByFamily.set(family, row);
    }
  }

  for (const [family, handlerKey] of RUNTIME_HANDLER_KEYS.entries()) {
    const row = rowsByFamily.get(family);
    assert.ok(row, `Matrix is missing a row for shipped family "${family}".`);
    const expectedCurrentState = DELEGATED_WRAPPER_FAMILIES.has(family)
      ? "delegated/wrapper"
      : "JS runtime";
    assert.equal(
      row.currentState,
      expectedCurrentState,
      `Matrix says "${family}" has drifted from the shipped runtime bucket.`,
    );
    assert.ok(
      runtimeManagerSource.includes(handlerKey),
      `Runtime manager no longer exposes the expected handler for "${family}".`,
    );
  }

  for (const family of ["rbe", "watch", "catch", "status", "complete", "comment"]) {
    const row = rowsByFamily.get(family);
    assert.ok(row, `Matrix is missing a row for shipped family "${family}".`);
    assert.equal(
      row.currentState,
      "editor-only",
      `Matrix says "${family}" is runtime-backed now, but the repo scan still shows no handler.`,
    );
    const handlerKey = RUNTIME_HANDLER_KEYS.get(family);
    if (handlerKey) {
      assert.equal(
        runtimeManagerSource.includes(handlerKey),
        false,
        `Editor-only family "${family}" unexpectedly has a runtime handler.`,
      );
    }
  }

  for (const family of ["inject", "http in"]) {
    const row = rowsByFamily.get(family);
    assert.ok(row, `Matrix is missing a row for shipped family "${family}".`);
    assert.equal(
      row.currentState,
      "delegated/wrapper",
      `Matrix no longer classifies "${family}" as delegated/wrapper.`,
    );
  }

  assert.match(
    flowLoweringSource,
    /if \(type === "inject"\)/,
    "Node-RED inject nodes should still lower to triggers.",
  );
  assert.match(
    flowLoweringSource,
    /if \(type === "http in"\)/,
    "Node-RED http in nodes should still lower to triggers.",
  );
  assert.match(
    runtimeManagerSource,
    /async function dispatchInjectNode\(nodeId, overrideMessage = null\)/,
    "The injected-node wrapper path disappeared from the runtime manager.",
  );
  assert.match(
    runtimeManagerSource,
    /async handleHttpRequest\(request = \{\}\)/,
    "The HTTP wrapper path disappeared from the runtime manager.",
  );
});

test("editor-only matrix families stay aligned with the explicit live-runtime rejection inventory", async () => {
  const matrixText = await fs.readFile(MATRIX_PATH, "utf8");
  const matrixRows = parseMatrixRows(matrixText);
  const editorOnlyFamilies = matrixRows
    .filter((row) => row.currentState === "editor-only")
    .flatMap((row) => splitFamilies(row.families))
    .sort();

  assert.deepEqual(
    [...EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILIES].sort(),
    editorOnlyFamilies,
    "The explicit editor-only live-runtime inventory drifted from the checked-in parity matrix.",
  );
});
