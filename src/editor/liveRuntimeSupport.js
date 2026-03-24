function normalizeString(value, fallback = "") {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export const EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILIES = Object.freeze([
  "rbe",
  "tcp in",
  "tcp out",
  "tcp request",
  "udp in",
  "udp out",
  "websocket in",
  "websocket out",
  "websocket-listener",
  "websocket-client",
  "mqtt in",
  "mqtt out",
  "watch",
  "catch",
  "status",
  "complete",
  "comment",
]);

const EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILY_SET = new Set(
  EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILIES,
);

export function isEditorOnlyLiveRuntimeFamily(type) {
  return EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILY_SET.has(
    normalizeString(type, "").toLowerCase(),
  );
}

export function collectEditorOnlyLiveRuntimeNodes(flows = []) {
  const unsupportedNodes = [];
  for (const entry of Array.isArray(flows) ? flows : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const type = normalizeString(entry.type, "");
    if (!isEditorOnlyLiveRuntimeFamily(type)) {
      continue;
    }
    unsupportedNodes.push({
      nodeId: normalizeString(entry.id, "unknown"),
      type,
    });
  }
  return unsupportedNodes;
}

function formatUnsupportedNodeEntry(node) {
  return `"${node.type}" (${node.nodeId})`;
}

export function createEditorOnlyLiveRuntimeWarning(node) {
  return [
    `Node-RED family ${formatUnsupportedNodeEntry(node)} remains editor-only for live execution.`,
    "Preview lowering is structural only until runtime support is added.",
  ].join(" ");
}

export function createEditorOnlyLiveRuntimeError(nodes = []) {
  const sortedNodes = [...nodes].sort((left, right) => {
    if (left.type !== right.type) {
      return left.type.localeCompare(right.type);
    }
    return left.nodeId.localeCompare(right.nodeId);
  });
  return (
    "Cannot compile a live runtime artifact for editor-only Node-RED families: " +
    `${sortedNodes.map(formatUnsupportedNodeEntry).join(", ")}. ` +
    "Add runtime support or remove those nodes from the live flow."
  );
}

export default {
  EDITOR_ONLY_LIVE_RUNTIME_NODE_FAMILIES,
  collectEditorOnlyLiveRuntimeNodes,
  createEditorOnlyLiveRuntimeError,
  createEditorOnlyLiveRuntimeWarning,
  isEditorOnlyLiveRuntimeFamily,
};
