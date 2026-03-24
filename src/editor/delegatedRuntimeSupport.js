function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

const delegatedRuntimeFamilies = Object.freeze([
  Object.freeze({
    family: "file",
    pluginId: "com.digitalarsenal.editor.file",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.file:invoke",
  }),
  Object.freeze({
    family: "file in",
    pluginId: "com.digitalarsenal.editor.file-in",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.file-in:invoke",
  }),
  Object.freeze({
    family: "delay",
    pluginId: "com.digitalarsenal.editor.delay",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.delay:invoke",
  }),
  Object.freeze({
    family: "trigger",
    pluginId: "com.digitalarsenal.editor.trigger",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.trigger:invoke",
  }),
  Object.freeze({
    family: "link in",
    pluginId: "com.digitalarsenal.editor.link-in",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.link-in:invoke",
  }),
  Object.freeze({
    family: "link out",
    pluginId: "com.digitalarsenal.editor.link-out",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.link-out:invoke",
  }),
  Object.freeze({
    family: "link call",
    pluginId: "com.digitalarsenal.editor.link-call",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.link-call:invoke",
  }),
  Object.freeze({
    family: "exec",
    pluginId: "com.digitalarsenal.editor.exec",
    methodId: "invoke",
    handlerKey: "com.digitalarsenal.editor.exec:invoke",
  }),
]);

const delegatedRuntimeFamiliesByFamily = new Map(
  delegatedRuntimeFamilies.map((entry) => [entry.family, entry]),
);
const delegatedRuntimeFamiliesByHandlerKey = new Map(
  delegatedRuntimeFamilies.map((entry) => [entry.handlerKey, entry]),
);
const delegatedRuntimeFamiliesByPluginMethod = new Map(
  delegatedRuntimeFamilies.map((entry) => [`${entry.pluginId}:${entry.methodId}`, entry]),
);

export function listSdnFlowEditorDelegatedRuntimeFamilies() {
  return delegatedRuntimeFamilies.map((entry) => ({ ...entry }));
}

export function resolveSdnFlowEditorDelegatedRuntimeFamily({
  family = null,
  handlerKey = null,
  pluginId = null,
  methodId = null,
} = {}) {
  const normalizedFamily = normalizeString(family, null);
  if (normalizedFamily && delegatedRuntimeFamiliesByFamily.has(normalizedFamily)) {
    return delegatedRuntimeFamiliesByFamily.get(normalizedFamily);
  }

  const normalizedHandlerKey = normalizeString(handlerKey, null);
  if (normalizedHandlerKey && delegatedRuntimeFamiliesByHandlerKey.has(normalizedHandlerKey)) {
    return delegatedRuntimeFamiliesByHandlerKey.get(normalizedHandlerKey);
  }

  const normalizedPluginId = normalizeString(pluginId, null);
  const normalizedMethodId = normalizeString(methodId, null);
  if (normalizedPluginId && normalizedMethodId) {
    return delegatedRuntimeFamiliesByPluginMethod.get(
      `${normalizedPluginId}:${normalizedMethodId}`,
    ) ?? null;
  }
  return null;
}

export function createSdnFlowEditorDelegatedRuntimeUnavailableError(
  definition = {},
  options = {},
) {
  const family = normalizeString(definition?.family, "delegated");
  const nodeId = normalizeString(options?.nodeId, null);
  const handlerKey = normalizeString(definition?.handlerKey, null);
  const detail = normalizeString(options?.detail, null);
  const message = [
    nodeId
      ? `Delegated editor runtime support for ${family} node "${nodeId}" is unavailable.`
      : `Delegated editor runtime support for ${family} is unavailable.`,
    detail ?? "Enable delegated support for this editor runtime target.",
  ].join(" ");
  const error = new Error(message);
  error.code = "SDN_FLOW_EDITOR_DELEGATED_RUNTIME_UNAVAILABLE";
  error.family = family;
  if (nodeId) {
    error.nodeId = nodeId;
  }
  if (handlerKey) {
    error.handlerKey = handlerKey;
  }
  return error;
}
