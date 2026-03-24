import {
  createEditorOnlyLiveRuntimeWarning,
  isEditorOnlyLiveRuntimeFamily,
} from "./liveRuntimeSupport.js";

function normalizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneEditorValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON normalization.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function extractEditorNodeConfig(node = {}) {
  const config = {};
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "id" ||
      key === "z" ||
      key === "type" ||
      key === "wires" ||
      key === "x" ||
      key === "y"
    ) {
      continue;
    }
    config[key] = cloneEditorValue(value);
  }
  return config;
}

function slugify(value, fallback = "sdn-flow-preview") {
  const slug = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function buildProgramId(tab, fallbackIndex = 1) {
  return slugify(tab?.label ?? tab?.id ?? `flow-${fallbackIndex}`);
}

function createOutputPortIds(count, basePortId = "out") {
  if (count <= 0) {
    return [];
  }
  if (count === 1) {
    return [basePortId];
  }
  return Array.from(
    { length: count },
    (_unused, index) => `${basePortId}-${index + 1}`,
  );
}

function parseRepeatIntervalMs(node) {
  const repeat = normalizeString(node?.repeat, "");
  if (!repeat) {
    return 0;
  }
  const seconds = Number.parseFloat(repeat);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.round(seconds * 1000);
}

function isTabNode(node) {
  return normalizeString(node?.type, "") === "tab";
}

function isSubflowDefinition(node) {
  const type = normalizeString(node?.type, "");
  return type === "subflow" || type.startsWith("subflow:");
}

function isConfigNode(node, workspaceIds) {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (isTabNode(node) || isSubflowDefinition(node)) {
    return false;
  }
  const workspaceId = normalizeString(node.z, "");
  return workspaceId.length === 0 || !workspaceIds.has(workspaceId);
}

function getDefaultInputPortId(type) {
  switch (type) {
    case "http response":
      return "response";
    case "http request":
      return "request";
    case "debug":
      return "in";
    default:
      return "in";
  }
}

function getDefaultOutputPortBase(type) {
  switch (type) {
    case "http request":
      return "response";
    case "switch":
      return "branch";
    default:
      return "out";
  }
}

function mapNodeTypeToRuntimeShape(type, node) {
  const normalizedType = normalizeString(type, "function");
  const wireCount = asArray(node?.wires).length;
  switch (normalizedType) {
    case "debug":
      return {
        kind: "debug",
        pluginId: "com.digitalarsenal.editor.debug",
        methodId: "write_debug",
        inputPortId: "in",
        outputPortIds: [],
      };
    case "http request":
      return {
        kind: "transform",
        pluginId: "com.digitalarsenal.flow.http-fetcher",
        methodId: "fetch",
        inputPortId: "request",
        outputPortIds: createOutputPortIds(wireCount, "response"),
      };
    case "http response":
      return {
        kind: "responder",
        pluginId: "com.digitalarsenal.flow.http-response",
        methodId: "send",
        inputPortId: "response",
        outputPortIds: [],
      };
    case "switch":
      return {
        kind: "analyzer",
        pluginId: "com.digitalarsenal.editor.switch",
        methodId: "route",
        inputPortId: "in",
        outputPortIds: createOutputPortIds(wireCount, "branch"),
      };
    case "function":
      return {
        kind: "transform",
        pluginId: "com.digitalarsenal.editor.function",
        methodId: "invoke",
        inputPortId: "in",
        outputPortIds: createOutputPortIds(wireCount, "out"),
      };
    default: {
      const typeSlug = slugify(normalizedType, "node");
      return {
        kind: wireCount === 0 ? "sink" : "transform",
        pluginId: `com.digitalarsenal.editor.${typeSlug}`,
        methodId: "invoke",
        inputPortId: getDefaultInputPortId(normalizedType),
        outputPortIds: createOutputPortIds(
          wireCount,
          getDefaultOutputPortBase(normalizedType),
        ),
      };
    }
  }
}

function buildTriggerForInjectNode(node) {
  const triggerId = `trigger-${normalizeString(node.id, "inject")}`;
  const intervalMs = parseRepeatIntervalMs(node);
  const hasSchedule =
    intervalMs > 0 ||
    normalizeString(node?.crontab, "").length > 0 ||
    node?.once === true;
  return {
    triggerId,
    kind: hasSchedule ? "timer" : "manual",
    source: normalizeString(node?.name, node?.id ?? triggerId),
    defaultIntervalMs: intervalMs,
  };
}

function normalizeHttpRoutePath(pathValue) {
  const normalized = normalizeString(pathValue, "/") ?? "/";
  if (normalized === "/") {
    return "/";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function buildTriggerForHttpInNode(node) {
  const triggerId = `trigger-${normalizeString(node.id, "http-in")}`;
  const routePath = normalizeHttpRoutePath(node?.url);
  const method = (
    normalizeString(node?.method, "get") ?? "get"
  ).toUpperCase();
  return {
    triggerId,
    kind: "http-request",
    source: routePath,
    description: `[${method}] ${routePath}`,
  };
}

export function convertNodeRedFlowsToSdnProgram(flows = []) {
  const nodes = asArray(flows).filter(
    (entry) => entry && typeof entry === "object",
  );
  const tabs = nodes.filter(isTabNode);
  const workspaceIds = new Set(
    tabs.map((entry) => normalizeString(entry.id, "")).filter(Boolean),
  );
  const warnings = [];

  const program = {
    programId: buildProgramId(tabs[0], 1),
    name: normalizeString(tabs[0]?.label, "Flow 1"),
    version: "0.1.0",
    description: normalizeString(tabs[0]?.info, ""),
    nodes: [],
    edges: [],
    triggers: [],
    triggerBindings: [],
    requiredPlugins: [],
    editor: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: {},
    },
  };

  const runtimeNodeMap = new Map();
  const flowNodes = nodes.filter(
    (entry) => !isTabNode(entry) && !isSubflowDefinition(entry),
  );

  for (const node of flowNodes) {
    if (isConfigNode(node, workspaceIds)) {
      warnings.push(
        `Ignored config node "${normalizeString(node.type, "unknown")}" (${normalizeString(node.id, "unknown")}).`,
      );
      continue;
    }

    const nodeId = normalizeString(node.id, "");
    const type = normalizeString(node.type, "function");
    program.editor.nodes[nodeId] = {
      x: Number(node.x ?? 0),
      y: Number(node.y ?? 0),
      type,
      config: extractEditorNodeConfig(node),
    };

    if (isEditorOnlyLiveRuntimeFamily(type)) {
      warnings.push(
        createEditorOnlyLiveRuntimeWarning({
          nodeId,
          type,
        }),
      );
    }

    if (type === "inject") {
      const trigger = buildTriggerForInjectNode(node);
      program.triggers.push(trigger);
      runtimeNodeMap.set(nodeId, {
        kind: "trigger",
        trigger,
        outputPortIds: ["out"],
      });
      continue;
    }

    if (type === "http in") {
      const trigger = buildTriggerForHttpInNode(node);
      program.triggers.push(trigger);
      runtimeNodeMap.set(nodeId, {
        kind: "trigger",
        trigger,
        outputPortIds: ["out"],
      });
      continue;
    }

    const runtimeShape = mapNodeTypeToRuntimeShape(type, node);
    const runtimeNode = {
      nodeId,
      pluginId: runtimeShape.pluginId,
      methodId: runtimeShape.methodId,
      kind: runtimeShape.kind,
    };
    program.nodes.push(runtimeNode);
    runtimeNodeMap.set(nodeId, {
      kind: "node",
      runtimeNode,
      inputPortId: runtimeShape.inputPortId,
      outputPortIds: runtimeShape.outputPortIds,
    });
  }

  const requiredPlugins = new Set();
  for (const runtimeNode of program.nodes) {
    if (runtimeNode.pluginId) {
      requiredPlugins.add(runtimeNode.pluginId);
    }
  }
  program.requiredPlugins = Array.from(requiredPlugins).sort();

  for (const node of flowNodes) {
    const nodeId = normalizeString(node.id, "");
    const runtimeShape = runtimeNodeMap.get(nodeId);
    if (!runtimeShape) {
      continue;
    }

    const wires = asArray(node.wires);
    for (let outputIndex = 0; outputIndex < wires.length; outputIndex += 1) {
      const targets = asArray(wires[outputIndex]);
      for (const targetId of targets) {
        const normalizedTargetId = normalizeString(targetId, "");
        const targetShape = runtimeNodeMap.get(normalizedTargetId);
        if (!targetShape) {
          warnings.push(
            `Ignored wire from "${nodeId}" to missing target "${normalizedTargetId}".`,
          );
          continue;
        }
        if (targetShape.kind === "trigger") {
          warnings.push(
            `Ignored wire from "${nodeId}" to inject node "${normalizedTargetId}".`,
          );
          continue;
        }

        if (runtimeShape.kind === "trigger") {
          program.triggerBindings.push({
            triggerId: runtimeShape.trigger.triggerId,
            targetNodeId: targetShape.runtimeNode.nodeId,
            targetPortId: targetShape.inputPortId,
          });
          continue;
        }

        const outputPortId =
          runtimeShape.outputPortIds[outputIndex] ??
          runtimeShape.outputPortIds[0] ??
          `out-${outputIndex + 1}`;
        program.edges.push({
          edgeId: `edge-${nodeId}-${outputIndex + 1}-${normalizedTargetId}`,
          fromNodeId: runtimeShape.runtimeNode.nodeId,
          fromPortId: outputPortId,
          toNodeId: targetShape.runtimeNode.nodeId,
          toPortId: targetShape.inputPortId,
        });
      }
    }
  }

  if (tabs.length > 1) {
    warnings.push(`Combined ${tabs.length} tabs into one preview program.`);
  }
  if (nodes.some(isSubflowDefinition)) {
    warnings.push("Subflow templates are not lowered into the preview yet.");
  }

  return {
    program,
    warnings,
  };
}

export default {
  convertNodeRedFlowsToSdnProgram,
};
