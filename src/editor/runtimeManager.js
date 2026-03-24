import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { exec as childProcessExec, spawn as childProcessSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { deserialize as deserializeStructuredValue, serialize as serializeStructuredValue } from "node:v8";
import cronosjs from "cronosjs";
import yaml from "js-yaml";
import mustache from "mustache";
import xml2js from "xml2js";
import cheerio from "cheerio";
import iconv from "iconv-lite";

import { deserializeCompiledArtifact } from "../deploy/compiledArtifact.js";
import { bindCompiledFlowRuntimeHost } from "../host/compiledFlowRuntimeHost.js";
import {
  createDefaultEditorManagedSecuritySettings,
  ensureManagedSecurityState,
  normalizeManagedSecuritySettings,
  normalizeStartupProtocol,
} from "../host/managedSecurity.js";
import { compileNodeRedFlowsToSdnArtifactInSubprocess } from "./compileArtifactSubprocess.js";
import {
  createSdnFlowEditorDelegatedRuntimeUnavailableError,
  listSdnFlowEditorDelegatedRuntimeFamilies,
  resolveSdnFlowEditorDelegatedRuntimeFamily,
} from "./delegatedRuntimeSupport.js";

const SDN_FLOW_EDITOR_DEFAULT_HOSTNAME = "127.0.0.1";
const SDN_FLOW_EDITOR_DEFAULT_PORT = 1990;
const SDN_FLOW_EDITOR_DEFAULT_BASE_PATH = "/";
const SDN_FLOW_EDITOR_DEFAULT_TITLE = "sdn-flow Editor";
const SDN_FLOW_EDITOR_LEGACY_DEFAULT_PORT = 8080;
const SDN_FLOW_EDITOR_DEFAULT_ARTIFACT_ARCHIVE_LIMIT = 100;
const SDN_FLOW_EDITOR_DEBUG_HISTORY_LIMIT = 200;
const SDN_FLOW_EDITOR_MAX_REPEAT_SECONDS = 2147483;
const SDN_FLOW_EDITOR_DEFAULT_ONCE_DELAY_SECONDS = 0.1;
const SDN_FLOW_EDITOR_DEFAULT_EXEC_MAX_BUFFER_BYTES = 10_000_000;
const SDN_FLOW_EDITOR_RUNTIME_MESSAGE_TYPE = Object.freeze({
  schemaName: "sdn-flow.editor.runtime-envelope",
  fileIdentifier: "SDRE",
  acceptsAnyFlatbuffer: true,
  wireFormat: "v8-structured",
  rootTypeName: "SdnFlowEditorRuntimeEnvelope",
});
const SDN_FLOW_EDITOR_RUNTIME_CLASSIFICATION = Object.freeze({
  COMPILED: "compiled",
  DELEGATED: "delegated",
  JS_SHIM: "js-shim",
});
const SDN_FLOW_EDITOR_TRIGGER_NOTHING = Symbol("sdn-flow.editor.trigger.nothing");

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toByteArray(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function encodeRuntimePayload(value) {
  return new Uint8Array(serializeStructuredValue(value ?? null));
}

function decodeRuntimePayload(value) {
  const bytes = toByteArray(value);
  if (!bytes || bytes.length === 0) {
    return null;
  }
  try {
    return deserializeStructuredValue(bytes);
  } catch {
    // Fall back for legacy JSON/text frames that may still be in flight.
  }
  const text = textDecoder.decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return new Uint8Array(bytes);
  }
}

function getObjectPathSegments(pathValue) {
  const normalized = normalizeString(pathValue, null);
  if (!normalized || normalized === "msg") {
    return [];
  }
  return normalized
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getObjectPathValue(target, pathValue, fallback = undefined) {
  const segments = getObjectPathSegments(pathValue);
  if (segments.length === 0) {
    return target;
  }
  let current = target;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return fallback;
    }
    current = current[segment];
  }
  return current;
}

function setObjectPathValue(target, pathValue, value) {
  const segments = getObjectPathSegments(pathValue);
  if (segments.length === 0) {
    if (target && typeof target === "object" && value && typeof value === "object") {
      Object.assign(target, value);
    }
    return target;
  }
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current[segment] || typeof current[segment] !== "object") {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = value;
  return target;
}

function deleteObjectPathValue(target, pathValue) {
  const segments = getObjectPathSegments(pathValue);
  if (segments.length === 0) {
    return false;
  }
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!current || typeof current !== "object" || !(segment in current)) {
      return false;
    }
    current = current[segment];
  }
  if (!current || typeof current !== "object") {
    return false;
  }
  return delete current[segments.at(-1)];
}

function cloneJsonCompatibleValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON normalization.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function getStoreEntryValue(store, key) {
  const normalizedKey = String(key ?? "");
  if (store instanceof Map) {
    return cloneJsonCompatibleValue(store.get(normalizedKey));
  }
  if (store && typeof store.get === "function") {
    return cloneJsonCompatibleValue(store.get(normalizedKey));
  }
  if (isPlainObject(store)) {
    return cloneJsonCompatibleValue(store[normalizedKey]);
  }
  return undefined;
}

function setStoreEntryValue(store, key, value) {
  const normalizedKey = String(key ?? "");
  const normalizedValue = cloneJsonCompatibleValue(value);
  if (store instanceof Map) {
    if (normalizedValue === undefined) {
      store.delete(normalizedKey);
    } else {
      store.set(normalizedKey, normalizedValue);
    }
    return normalizedValue;
  }
  if (store && typeof store.set === "function") {
    store.set(normalizedKey, normalizedValue);
    return normalizedValue;
  }
  if (isPlainObject(store)) {
    if (normalizedValue === undefined) {
      delete store[normalizedKey];
    } else {
      store[normalizedKey] = normalizedValue;
    }
    return normalizedValue;
  }
  return normalizedValue;
}

function normalizeNodeRedOutputPortIds(node = {}) {
  const type = normalizeString(node?.type, "function") ?? "function";
  const explicitOutputs = Number.parseInt(String(node?.outputs ?? NaN), 10);
  const wireCount = asArray(node?.wires).length;
  const outputCount = Number.isFinite(explicitOutputs)
    ? Math.max(explicitOutputs, wireCount)
    : wireCount;
  if (outputCount <= 0) {
    return [];
  }
  const basePortId = type === "switch"
    ? "branch"
    : type === "http request"
      ? "response"
      : "out";
  if (outputCount === 1) {
    return [basePortId];
  }
  return Array.from({ length: outputCount }, (_, index) => `${basePortId}-${index + 1}`);
}

function createEmptyRuntimeClassificationStatus() {
  return {
    summary: {
      totalNodes: 0,
      families: 0,
      handlers: 0,
      byClassification: {
        compiled: 0,
        delegated: 0,
        "js-shim": 0,
      },
    },
    nodeFamilies: [],
    handlers: [],
  };
}

function normalizeDelegatedRuntimeSupportOptions(options = {}) {
  if (options?.delegatedRuntimeSupport === false) {
    return {
      enabled: false,
      handlers: {},
    };
  }
  if (
    options?.delegatedRuntimeSupport &&
    typeof options.delegatedRuntimeSupport === "object" &&
    !Array.isArray(options.delegatedRuntimeSupport)
  ) {
    return {
      enabled: options.delegatedRuntimeSupport.enabled !== false,
      handlers: options.delegatedRuntimeSupport.handlers ?? {},
    };
  }
  return {
    enabled: true,
    handlers: {},
  };
}

function isNodeRedTabNode(node = {}) {
  return normalizeString(node?.type, null) === "tab";
}

function isNodeRedSubflowDefinition(node = {}) {
  const type = normalizeString(node?.type, null);
  return type === "subflow" || type?.startsWith("subflow:") === true;
}

function isNodeRedConfigNode(node = {}, workspaceIds = new Set()) {
  if (!isPlainObject(node)) {
    return false;
  }
  if (isNodeRedTabNode(node) || isNodeRedSubflowDefinition(node)) {
    return false;
  }
  const workspaceId = normalizeString(node?.z, "");
  return workspaceId.length === 0 || !workspaceIds.has(workspaceId);
}

function slugifyEditorNodeType(value, fallback = "node") {
  const normalized = normalizeString(value, fallback) ?? fallback;
  const slug = normalized
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function deriveRuntimeInvocationIdentity(node = {}, runtimeNode = null) {
  const pluginId = normalizeString(runtimeNode?.pluginId, null);
  const methodId = normalizeString(runtimeNode?.methodId, null);
  if (pluginId || methodId) {
    return {
      pluginId,
      methodId,
    };
  }
  const type = normalizeString(node?.type, "function") ?? "function";
  switch (type) {
    case "debug":
      return {
        pluginId: "com.digitalarsenal.editor.debug",
        methodId: "write_debug",
      };
    case "http request":
      return {
        pluginId: "com.digitalarsenal.flow.http-fetcher",
        methodId: "fetch",
      };
    case "http response":
      return {
        pluginId: "com.digitalarsenal.flow.http-response",
        methodId: "send",
      };
    case "switch":
      return {
        pluginId: "com.digitalarsenal.editor.switch",
        methodId: "route",
      };
    case "function":
      return {
        pluginId: "com.digitalarsenal.editor.function",
        methodId: "invoke",
      };
    default:
      return {
        pluginId: `com.digitalarsenal.editor.${slugifyEditorNodeType(type)}`,
        methodId: "invoke",
      };
  }
}

function createRuntimeHandlerLookupKeys({
  pluginId = null,
  methodId = null,
  dependencyId = null,
  nodeId = null,
} = {}) {
  return [
    dependencyId && methodId ? `${dependencyId}:${methodId}` : null,
    pluginId && methodId ? `${pluginId}:${methodId}` : null,
    nodeId && methodId ? `${nodeId}:${methodId}` : null,
    dependencyId,
    pluginId,
    nodeId,
    methodId,
  ].filter(Boolean);
}

function inferDebugFormat(value) {
  if (value === null) {
    return "null";
  }
  if (value instanceof Uint8Array) {
    return `Uint8Array[${value.length}]`;
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function evaluateTypedInputValue(rawValue, rawType, options = {}) {
  const type = normalizeString(rawType, "str") ?? "str";
  switch (type) {
    case "date":
      return Date.now();
    case "num": {
      const parsed = Number.parseFloat(String(rawValue ?? 0));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case "bool":
      return rawValue === true || String(rawValue).toLowerCase() === "true";
    case "json":
      if (rawValue && typeof rawValue === "object") {
        return cloneJsonCompatibleValue(rawValue);
      }
      try {
        return JSON.parse(String(rawValue ?? "null"));
      } catch {
        return null;
      }
    case "bin": {
      if (rawValue instanceof Uint8Array) {
        return Array.from(rawValue);
      }
      if (Array.isArray(rawValue)) {
        return rawValue.map((entry) => Number(entry) >>> 0);
      }
      try {
        const parsed = JSON.parse(String(rawValue ?? "[]"));
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    case "env":
      return options.env?.[String(rawValue ?? "")] ?? "";
    case "flow":
      return getStoreEntryValue(options.flow, rawValue);
    case "global":
      return getStoreEntryValue(options.global, rawValue);
    case "msg":
      return getObjectPathValue(options.msg ?? {}, rawValue, null);
    case "str":
    default:
      return String(rawValue ?? "");
  }
}

function escapeRegExp(value) {
  return String(value ?? "").replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function buildChangeMatcher(fromValue, fromType) {
  if (fromType === "re") {
    return {
      type: "re",
      value: fromValue,
      regex: fromValue instanceof RegExp ? fromValue : new RegExp(String(fromValue ?? ""), "g"),
    };
  }
  if (fromValue instanceof RegExp) {
    return {
      type: "re",
      value: fromValue,
      regex: fromValue,
    };
  }
  if (typeof fromValue === "number") {
    return {
      type: "num",
      value: fromValue,
      regex: null,
    };
  }
  if (typeof fromValue === "boolean") {
    return {
      type: "bool",
      value: fromValue,
      regex: null,
    };
  }
  return {
    type: "str",
    value: String(fromValue ?? ""),
    regex: new RegExp(escapeRegExp(fromValue), "g"),
  };
}

function extractMustacheTokens(tokens, set = new Set()) {
  for (const token of asArray(tokens)) {
    if (token?.[0] !== "text") {
      set.add(token?.[1]);
      if (token.length > 4) {
        extractMustacheTokens(token[4], set);
      }
    }
  }
  return set;
}

function parseTemplateContext(name) {
  const match = /^(flow|global)(?:\[(\w+)\])?\.(.+)/.exec(String(name ?? ""));
  if (!match) {
    return undefined;
  }
  return {
    type: match[1],
    store: match[2] === "" ? "default" : match[2],
    field: match[3],
  };
}

function parseTemplateEnv(name) {
  const match = /^env\.(.+)/.exec(String(name ?? ""));
  return match?.[1];
}

function escapeTemplateJsonString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\f/g, "\\f")
    .replace(/[\b]/g, "\\b");
}

function getContextStorePathValue(store, key) {
  const normalizedKey = normalizeString(key, null);
  if (!normalizedKey) {
    return undefined;
  }
  const directValue = getStoreEntryValue(store, normalizedKey);
  if (directValue !== undefined) {
    return directValue;
  }
  if (isPlainObject(store)) {
    const nestedValue = getObjectPathValue(store, normalizedKey, undefined);
    if (nestedValue !== undefined) {
      return cloneJsonCompatibleValue(nestedValue);
    }
  }
  const segments = getObjectPathSegments(normalizedKey);
  if (segments.length <= 1) {
    return undefined;
  }
  const rootValue = getStoreEntryValue(store, segments[0]);
  if (rootValue === undefined) {
    return undefined;
  }
  return cloneJsonCompatibleValue(
    getObjectPathValue(rootValue, segments.slice(1).join("."), undefined),
  );
}

function SdnFlowEditorTemplateContext(message, nodeContext, parent, escapeStrings, resolvedTokens) {
  this.msgContext = new mustache.Context(message, parent);
  this.nodeContext = nodeContext;
  this.escapeStrings = escapeStrings;
  this.resolvedTokens = resolvedTokens;
}

SdnFlowEditorTemplateContext.prototype = new mustache.Context();

SdnFlowEditorTemplateContext.prototype.lookup = function lookup(name) {
  const value = this.msgContext.lookup(name);
  if (value !== undefined) {
    if (this.escapeStrings && typeof value === "string") {
      return escapeTemplateJsonString(value);
    }
    return value;
  }
  if (parseTemplateEnv(name)) {
    return this.resolvedTokens[name];
  }
  if (parseTemplateContext(name)) {
    return this.resolvedTokens[name];
  }
  return "";
};

SdnFlowEditorTemplateContext.prototype.push = function push(view) {
  return new SdnFlowEditorTemplateContext(
    view,
    this.nodeContext,
    this.msgContext,
    this.escapeStrings,
    this.resolvedTokens,
  );
};

function getChangeTargetValue(targetType, propertyPath, message, options = {}) {
  const normalizedType = normalizeString(targetType, "msg") ?? "msg";
  if (normalizedType === "flow") {
    return getStoreEntryValue(options.flow, propertyPath);
  }
  if (normalizedType === "global") {
    return getStoreEntryValue(options.global, propertyPath);
  }
  return cloneJsonCompatibleValue(getObjectPathValue(message, propertyPath, undefined));
}

function setChangeTargetValue(targetType, propertyPath, value, message, options = {}) {
  const normalizedType = normalizeString(targetType, "msg") ?? "msg";
  if (normalizedType === "flow") {
    setStoreEntryValue(options.flow, propertyPath, value);
    return message;
  }
  if (normalizedType === "global") {
    setStoreEntryValue(options.global, propertyPath, value);
    return message;
  }
  setObjectPathValue(message, propertyPath, cloneJsonCompatibleValue(value));
  return message;
}

function deleteChangeTargetValue(targetType, propertyPath, message, options = {}) {
  const normalizedType = normalizeString(targetType, "msg") ?? "msg";
  if (normalizedType === "flow") {
    setStoreEntryValue(options.flow, propertyPath, undefined);
    return message;
  }
  if (normalizedType === "global") {
    setStoreEntryValue(options.global, propertyPath, undefined);
    return message;
  }
  deleteObjectPathValue(message, propertyPath);
  return message;
}

export function applySdnFlowEditorChangeNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const rules = asArray(nodeConfig?.rules);
  for (const rawRule of rules) {
    const action = normalizeString(rawRule?.t, "set") ?? "set";
    const propertyPath = normalizeString(rawRule?.p, "");
    const propertyType = normalizeString(rawRule?.pt, "msg") ?? "msg";
    if (!propertyPath) {
      continue;
    }
    if (action === "delete") {
      deleteChangeTargetValue(propertyType, propertyPath, message, options);
      continue;
    }

    if (action === "move") {
      const targetPath = normalizeString(rawRule?.to, "");
      const targetType = normalizeString(rawRule?.tot, "msg") ?? "msg";
      if (!targetPath) {
        continue;
      }
      const movedValue = getChangeTargetValue(propertyType, propertyPath, message, options);
      deleteChangeTargetValue(propertyType, propertyPath, message, options);
      if (movedValue !== undefined) {
        setChangeTargetValue(targetType, targetPath, movedValue, message, options);
      }
      continue;
    }

    const targetType =
      action === "set"
        ? normalizeString(rawRule?.tot, "str") ?? "str"
        : normalizeString(rawRule?.tot, "str") ?? "str";
    const toValue = evaluateTypedInputValue(rawRule?.to, targetType, {
      env: options.env,
      msg: message,
      flow: options.flow,
      global: options.global,
    });
    const normalizedToValue =
      rawRule?.dc === true || rawRule?.dc === "true"
        ? cloneJsonCompatibleValue(toValue)
        : toValue;

    if (action === "set") {
      setChangeTargetValue(propertyType, propertyPath, normalizedToValue, message, options);
      continue;
    }

    if (action !== "change") {
      continue;
    }

    const currentValue = getChangeTargetValue(propertyType, propertyPath, message, options);
    const fromType = normalizeString(rawRule?.fromt, "str") ?? "str";
    const fromValue = evaluateTypedInputValue(rawRule?.from, fromType, {
      env: options.env,
      msg: message,
      flow: options.flow,
      global: options.global,
    });
    const matcher = buildChangeMatcher(fromValue, fromType);

    if (typeof currentValue === "string") {
      if (
        (matcher.type === "num" || matcher.type === "bool" || matcher.type === "str") &&
        currentValue === String(matcher.value)
      ) {
        setChangeTargetValue(propertyType, propertyPath, normalizedToValue, message, options);
        continue;
      }
      if (matcher.regex) {
        let replacedValue = currentValue.replace(matcher.regex, String(normalizedToValue ?? ""));
        if (
          targetType === "bool" &&
          typeof normalizedToValue === "boolean" &&
          replacedValue === String(normalizedToValue)
        ) {
          replacedValue = normalizedToValue;
        }
        setChangeTargetValue(propertyType, propertyPath, replacedValue, message, options);
      }
      continue;
    }

    if (
      (typeof currentValue === "number" || currentValue instanceof Number) &&
      matcher.type === "num" &&
      Number(currentValue) === Number(matcher.value)
    ) {
      setChangeTargetValue(propertyType, propertyPath, normalizedToValue, message, options);
      continue;
    }

    if (
      typeof currentValue === "boolean" &&
      matcher.type === "bool" &&
      String(currentValue) === String(matcher.value)
    ) {
      setChangeTargetValue(propertyType, propertyPath, normalizedToValue, message, options);
    }
  }
  return message;
}

export function applySdnFlowEditorJsonNodeMessage(nodeConfig = {}, inputMessage = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  const action = normalizeString(nodeConfig?.action, "") ?? "";
  const indent = nodeConfig?.pretty ? 4 : 0;
  const currentValue = getObjectPathValue(message, propertyPath, undefined);
  if (currentValue === undefined) {
    return message;
  }

  if (typeof currentValue === "string" || currentValue instanceof Uint8Array) {
    if (action === "" || action === "obj") {
      const text = currentValue instanceof Uint8Array ? textDecoder.decode(currentValue) : currentValue;
      setObjectPathValue(message, propertyPath, JSON.parse(text));
    }
    return message;
  }

  if (
    currentValue !== null &&
    (typeof currentValue === "object" || typeof currentValue === "boolean" || typeof currentValue === "number")
  ) {
    if (action === "" || action === "str") {
      setObjectPathValue(message, propertyPath, JSON.stringify(currentValue, null, indent));
    }
    return message;
  }

  return null;
}

export function applySdnFlowEditorTemplateNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const outputMessage =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const fieldType = normalizeString(nodeConfig?.fieldType, "msg") ?? "msg";
  const field = normalizeString(nodeConfig?.field, "payload") ?? "payload";
  const syntax = normalizeString(nodeConfig?.syntax, "mustache") ?? "mustache";
  const outputFormat = normalizeString(nodeConfig?.output, "str") ?? "str";
  let templateSource = nodeConfig?.template;

  if (
    Object.prototype.hasOwnProperty.call(outputMessage, "template") &&
    (templateSource === "" || templateSource === null || templateSource === undefined)
  ) {
    templateSource = outputMessage.template;
  }

  templateSource = String(templateSource ?? "");
  let renderedValue = templateSource;

  if (syntax === "mustache") {
    const resolvedTokens = {};
    const tokens = extractMustacheTokens(mustache.parse(templateSource));
    for (const name of tokens) {
      const envName = parseTemplateEnv(name);
      if (envName) {
        resolvedTokens[name] = options.env?.[envName] ?? "";
        continue;
      }
      const context = parseTemplateContext(name);
      if (!context) {
        continue;
      }
      const store = context.type === "flow" ? options.flow : options.global;
      resolvedTokens[name] = getContextStorePathValue(store, context.field);
    }
    renderedValue = mustache.render(
      templateSource,
      new SdnFlowEditorTemplateContext(
        outputMessage,
        {
          flow: options.flow,
          global: options.global,
        },
        null,
        outputFormat === "json",
        resolvedTokens,
      ),
    );
  }

  if (outputFormat === "json") {
    renderedValue = JSON.parse(renderedValue);
  } else if (outputFormat === "yaml") {
    renderedValue = yaml.load(renderedValue);
  }

  if (fieldType === "flow") {
    setStoreEntryValue(options.flow, field, renderedValue);
    return outputMessage;
  }
  if (fieldType === "global") {
    setStoreEntryValue(options.global, field, renderedValue);
    return outputMessage;
  }

  setObjectPathValue(outputMessage, field, cloneJsonCompatibleValue(renderedValue));
  return outputMessage;
}

export function applySdnFlowEditorRangeNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const outputMessage =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  const inputValue = getObjectPathValue(outputMessage, propertyPath, undefined);
  if (inputValue === undefined) {
    return outputMessage;
  }

  let minin = Number(nodeConfig?.minin);
  let maxin = Number(nodeConfig?.maxin);
  let minout = Number(nodeConfig?.minout);
  let maxout = Number(nodeConfig?.maxout);

  if (minin > maxin) {
    [minin, maxin] = [maxin, minin];
    [minout, maxout] = [maxout, minout];
  }

  const round = nodeConfig?.round === true || nodeConfig?.round === "true";
  if (round) {
    maxout = Math.floor(maxout);
    minout = Math.ceil(minout);
  }

  let numericValue = Number(inputValue);
  if (Number.isNaN(numericValue)) {
    options.nodeApi?.log?.(`range value is not numeric: ${inputValue}`);
    return null;
  }

  const action = normalizeString(nodeConfig?.action, "scale") ?? "scale";
  if (action === "drop") {
    if (numericValue < minin || numericValue > maxin) {
      return null;
    }
  } else if (action === "clamp") {
    if (numericValue < minin) {
      numericValue = minin;
    }
    if (numericValue > maxin) {
      numericValue = maxin;
    }
  } else if (action === "roll") {
    const divisor = maxin - minin;
    numericValue = ((numericValue - minin) % divisor + divisor) % divisor + minin;
  }

  let outputValue =
    ((numericValue - minin) / (maxin - minin) * (maxout - minout)) + minout;
  if (round) {
    outputValue = Math.round(outputValue);
  }
  setObjectPathValue(outputMessage, propertyPath, outputValue);
  return outputMessage;
}

function normalizeSdnFlowEditorCsvControlString(value, fallback) {
  return String(value ?? fallback)
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
}

function quoteSdnFlowEditorCsvCell(value, options = {}) {
  const separator = String(options.separator ?? ",");
  const quote = String(options.quote ?? "\"");
  const cell = String(value ?? "");
  if (
    !cell.includes(separator) &&
    !cell.includes(quote) &&
    !cell.includes("\n") &&
    !cell.includes("\r")
  ) {
    return cell;
  }
  return `${quote}${cell.replaceAll(quote, `${quote}${quote}`)}${quote}`;
}

function parseSdnFlowEditorCsvRows(csvInput, options = {}) {
  const text = String(csvInput ?? "");
  const separator = String(options.separator ?? ",");
  const quote = String(options.quote ?? "\"");
  const strict = options.strict === true;
  const rows = [];
  const cellBuilder = [];
  let rowBuilder = [];
  let cursor = 0;
  let newCell = true;
  let inQuote = false;
  let closed = false;

  const finalizeCell = () => {
    const cell = cellBuilder.join("");
    cellBuilder.length = 0;
    rowBuilder.push(cell || (newCell ? null : ""));
    newCell = true;
    closed = false;
  };

  const finalizeRow = () => {
    if (cellBuilder.length > 0 || rowBuilder.length > 0 || !newCell) {
      finalizeCell();
      if (rowBuilder.length > 0) {
        rows.push(rowBuilder);
      }
      rowBuilder = [];
    }
    newCell = true;
    closed = false;
  };

  while (cursor < text.length) {
    const char = text[cursor];
    if (inQuote) {
      if (char === quote && text[cursor + 1] === quote) {
        cellBuilder.push(quote);
        cursor += 2;
        newCell = false;
        closed = false;
        continue;
      }
      if (char === quote) {
        inQuote = false;
        cursor += 1;
        newCell = false;
        closed = true;
        continue;
      }
      cellBuilder.push(char);
      cursor += 1;
      newCell = false;
      closed = false;
      continue;
    }

    if (char === separator) {
      finalizeCell();
      cursor += 1;
      continue;
    }

    if (char === quote) {
      if (newCell) {
        inQuote = true;
        cursor += 1;
        newCell = false;
        closed = false;
        continue;
      }
      if (strict) {
        throw new Error(`Unexpected quote at column ${cursor}.`);
      }
    }

    if (char === "\n" || char === "\r") {
      finalizeRow();
      if (char === "\r" && text[cursor + 1] === "\n") {
        cursor += 2;
      } else {
        cursor += 1;
      }
      continue;
    }

    if (closed && strict) {
      throw new Error(`Unexpected data after closing quote at column ${cursor}.`);
    }
    cellBuilder.push(char);
    cursor += 1;
    newCell = false;
    closed = false;
  }

  if (strict && inQuote) {
    throw new Error("Missing closing quote in CSV input.");
  }

  finalizeRow();
  return rows;
}

function parseSdnFlowEditorCsvTemplate(templateString) {
  if (normalizeString(templateString, null) === null) {
    return [];
  }
  return parseSdnFlowEditorCsvRows(templateString, {
    separator: ",",
    quote: "\"",
    strict: true,
  })[0] ?? [];
}

function formatSdnFlowEditorCsvColumns(headers = [], options = {}) {
  const separator = String(options.separator ?? ",");
  const keepEmptyColumns = options.keepEmptyColumns === true;
  const formattedHeaders = [];
  for (const header of asArray(headers)) {
    const normalizedHeader = header === null || header === undefined ? "" : String(header);
    if (!keepEmptyColumns && normalizedHeader === "") {
      continue;
    }
    formattedHeaders.push(
      quoteSdnFlowEditorCsvCell(normalizedHeader, {
        separator,
        quote: "\"",
      }),
    );
  }
  return formattedHeaders.join(separator);
}

function shouldCoerceSdnFlowEditorCsvNumber(value) {
  return typeof value === "string" && value !== "" && !/^ *(\+|-0\d|0\d)/.test(value) && !Number.isNaN(+value);
}

function ensureSdnFlowEditorCsvHeaders(headers = [], row = null) {
  if (asArray(headers).length > 0) {
    return [...headers];
  }
  if (Array.isArray(row)) {
    return row.map((_, index) => `col${index + 1}`);
  }
  if (isPlainObject(row)) {
    return Object.keys(row);
  }
  return [];
}

function normalizeSdnFlowEditorSequenceControlString(value, fallback) {
  return normalizeSdnFlowEditorCsvControlString(value, fallback);
}

function parseSdnFlowEditorBinaryControlValue(value) {
  const rawValue = normalizeString(value, null);
  if (!rawValue) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (
      Array.isArray(parsed) &&
      parsed.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
    ) {
      return Buffer.from(parsed);
    }
  } catch {
    // Ignore invalid binary control definitions and let callers fall back.
  }
  return null;
}

function createSdnFlowEditorSequenceMessageBase(inputMessage, propertyPath = "payload") {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const existingParts = message.parts ? cloneJsonCompatibleValue(message.parts) : null;
  delete message._msgid;
  message.parts = existingParts ? { parts: existingParts } : {};
  message.parts.id = randomUUID().replaceAll("-", "");
  if (propertyPath !== "payload") {
    message.parts.property = propertyPath;
  }
  return message;
}

function createSdnFlowEditorSplitOutputMessage(baseMessage, propertyPath, value, parts) {
  const nextMessage = cloneJsonCompatibleValue(baseMessage);
  setObjectPathValue(nextMessage, propertyPath, value);
  nextMessage.parts = {
    ...(nextMessage.parts ?? {}),
    ...parts,
  };
  return nextMessage;
}

function toSdnFlowEditorSequenceBuffer(value) {
  const bytes = toByteArray(value);
  return bytes ? Buffer.from(bytes) : null;
}

function normalizeSdnFlowEditorSplitChunkLength(rawValue, fallback = 1) {
  const parsed = Number.parseInt(String(rawValue ?? fallback), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

function splitSdnFlowEditorBufferByDelimiter(bufferValue, delimiter) {
  const chunks = [];
  let cursor = 0;
  let index = bufferValue.indexOf(delimiter, cursor);
  while (index >= 0) {
    chunks.push(bufferValue.subarray(cursor, index));
    cursor = index + delimiter.length;
    index = bufferValue.indexOf(delimiter, cursor);
  }
  return {
    chunks,
    remainder: bufferValue.subarray(cursor),
  };
}

function normalizeSdnFlowEditorSortTargetType(nodeConfig = {}) {
  return normalizeString(nodeConfig?.targetType, "msg") ?? "msg";
}

function normalizeSdnFlowEditorSortKeyType(nodeConfig = {}, targetType = "msg") {
  if (targetType === "seq") {
    return normalizeString(nodeConfig?.seqKeyType, "msg") ?? "msg";
  }
  return normalizeString(nodeConfig?.msgKeyType, "elem") ?? "elem";
}

function normalizeSdnFlowEditorSortKeyPath(nodeConfig = {}, targetType = "msg") {
  if (targetType === "seq") {
    return normalizeString(nodeConfig?.seqKey, "payload") ?? "payload";
  }
  return normalizeString(nodeConfig?.msgKey, "payload") ?? "payload";
}

function normalizeSdnFlowEditorSortStateRecord(record = null) {
  if (record && record.groups instanceof Map) {
    return record;
  }
  return {
    groups: new Map(),
    pendingSequence: 0,
  };
}

function resolveSdnFlowEditorSortElementValue(element, keyPath) {
  const normalizedPath = normalizeString(keyPath, "") ?? "";
  if (!normalizedPath || normalizedPath === "." || normalizedPath === "$") {
    return cloneJsonCompatibleValue(element);
  }
  const directValue = getObjectPathValue(element, normalizedPath, undefined);
  if (directValue !== undefined) {
    return cloneJsonCompatibleValue(directValue);
  }
  if ((element === null || typeof element !== "object") && normalizedPath === "payload") {
    return cloneJsonCompatibleValue(element);
  }
  return undefined;
}

function compareSdnFlowEditorSortValues(left, right, direction, asNumber) {
  const normalizedLeft = asNumber ? Number(left) : left;
  const normalizedRight = asNumber ? Number(right) : right;
  if (normalizedLeft === normalizedRight) {
    return 0;
  }
  if (normalizedLeft > normalizedRight) {
    return direction;
  }
  return -direction;
}

function buildSdnFlowEditorSortComparator(nodeConfig = {}, targetType = "msg", options = {}) {
  const direction =
    (normalizeString(nodeConfig?.order, "ascending") ?? "ascending") === "descending" ? -1 : 1;
  const asNumber = normalizeBooleanFlag(nodeConfig?.as_num);
  const keyType = normalizeSdnFlowEditorSortKeyType(nodeConfig, targetType);
  const keyPath = normalizeSdnFlowEditorSortKeyPath(nodeConfig, targetType);
  if (keyType === "jsonata") {
    options.nodeApi?.warn?.("Sort JSONata keys are not supported yet.");
    return null;
  }
  return (left, right) => {
    const leftValue =
      targetType === "seq"
        ? getObjectPathValue(left, keyPath, undefined)
        : resolveSdnFlowEditorSortElementValue(left, keyPath);
    const rightValue =
      targetType === "seq"
        ? getObjectPathValue(right, keyPath, undefined)
        : resolveSdnFlowEditorSortElementValue(right, keyPath);
    return compareSdnFlowEditorSortValues(leftValue, rightValue, direction, asNumber);
  };
}

function buildSdnFlowEditorSortedSequenceMessages(messages = [], nodeConfig = {}, options = {}) {
  const comparator = buildSdnFlowEditorSortComparator(nodeConfig, "seq", options);
  if (!comparator) {
    return null;
  }
  const sortedMessages = asArray(messages)
    .map((message) => cloneJsonCompatibleValue(message))
    .sort(comparator);
  for (let index = 0; index < sortedMessages.length; index += 1) {
    if (!isPlainObject(sortedMessages[index].parts)) {
      sortedMessages[index].parts = {};
    }
    sortedMessages[index].parts.index = index;
    if (Number.isFinite(Number(sortedMessages[index].parts.count))) {
      sortedMessages[index].parts.count = Number(sortedMessages[index].parts.count);
    }
  }
  return sortedMessages;
}

export function applySdnFlowEditorSortNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const state = normalizeSdnFlowEditorSortStateRecord(options.state);
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const targetType = normalizeSdnFlowEditorSortTargetType(nodeConfig);

  if (targetType === "seq") {
    const parts = isPlainObject(message.parts) ? message.parts : null;
    const partId = normalizeString(parts?.id, null);
    const partIndex = Number.isFinite(Number(parts?.index)) ? Number(parts.index) : null;
    if (!partId || partIndex === null) {
      return null;
    }
    let group = state.groups.get(partId);
    if (!group) {
      group = {
        seq: state.pendingSequence++,
        count: Number.isFinite(Number(parts?.count)) ? Number(parts.count) : 0,
        messages: [],
      };
      state.groups.set(partId, group);
    }
    if (Number.isFinite(Number(parts?.count))) {
      group.count = Number(parts.count);
    }
    group.messages.push(message);
    if (group.count > 0 && group.messages.length >= group.count) {
      state.groups.delete(partId);
      return buildSdnFlowEditorSortedSequenceMessages(group.messages, nodeConfig, options);
    }
    return null;
  }

  const targetPath = normalizeString(nodeConfig?.target, "payload") ?? "payload";
  const targetValue = getObjectPathValue(message, targetPath, undefined);
  if (!Array.isArray(targetValue)) {
    return null;
  }
  const comparator = buildSdnFlowEditorSortComparator(nodeConfig, "msg", options);
  if (!comparator) {
    return null;
  }
  const sortedValue = targetValue.map((entry) => cloneJsonCompatibleValue(entry)).sort(comparator);
  setObjectPathValue(message, targetPath, sortedValue);
  return message;
}

export function applySdnFlowEditorSplitNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  const state = options.state ?? {
    sequenceIndex: 0,
    remainder: "",
    buffer: Buffer.alloc(0),
  };
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const currentValue = getObjectPathValue(message, propertyPath, undefined);
  if (currentValue === undefined) {
    return null;
  }

  const stream = normalizeBooleanFlag(nodeConfig?.stream);
  const baseMessage = createSdnFlowEditorSequenceMessageBase(message, propertyPath);
  const outputs = [];
  const pushOutput = (value, parts = {}) => {
    outputs.push(
      createSdnFlowEditorSplitOutputMessage(baseMessage, propertyPath, value, parts),
    );
  };

  if (typeof currentValue === "string") {
    const splitType = normalizeString(nodeConfig?.spltType, "str") ?? "str";
    if (splitType === "len") {
      const chunkLength = normalizeSdnFlowEditorSplitChunkLength(nodeConfig?.splt, 1);
      const combinedValue = `${String(state.remainder ?? "")}${currentValue}`;
      const totalCount = Math.ceil(combinedValue.length / chunkLength);
      if (!stream) {
        state.sequenceIndex = 0;
      }
      let cursor = 0;
      while (cursor + chunkLength < combinedValue.length) {
        pushOutput(
          combinedValue.slice(cursor, cursor + chunkLength),
          {
            type: "string",
            ch: "",
            len: chunkLength,
            index: state.sequenceIndex++,
            ...(stream ? {} : { count: totalCount }),
          },
        );
        cursor += chunkLength;
      }
      const remainder = combinedValue.slice(cursor);
      state.remainder = remainder;
      if (remainder.length > 0 && (!stream || remainder.length === chunkLength)) {
        pushOutput(
          remainder,
          {
            type: "string",
            ch: "",
            len: chunkLength,
            index: state.sequenceIndex++,
            ...(stream ? {} : { count: totalCount }),
          },
        );
        state.remainder = "";
      }
      if (!stream) {
        state.sequenceIndex = 0;
      }
      return outputs;
    }

    let delimiter = normalizeSdnFlowEditorSequenceControlString(nodeConfig?.splt, "\n");
    if (splitType === "bin") {
      const binaryDelimiter = parseSdnFlowEditorBinaryControlValue(nodeConfig?.splt);
      if (binaryDelimiter) {
        delimiter = binaryDelimiter.toString();
      }
    }
    const parts = `${String(state.remainder ?? "")}${currentValue}`.split(delimiter);
    const lastIndex = stream ? Math.max(parts.length - 1, 0) : parts.length;
    for (let index = 0; index < lastIndex; index += 1) {
      pushOutput(
        parts[index],
        {
          type: "string",
          ch: delimiter,
          index: state.sequenceIndex++,
          ...(stream ? {} : { count: parts.length }),
        },
      );
    }
    state.remainder = stream ? (parts.at(-1) ?? "") : "";
    if (!stream) {
      state.sequenceIndex = 0;
    }
    return outputs;
  }

  if (Array.isArray(currentValue)) {
    const chunkLength = normalizeSdnFlowEditorSplitChunkLength(nodeConfig?.arraySplt, 1);
    const chunkCount = Math.ceil(currentValue.length / chunkLength);
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = currentValue.slice(index * chunkLength, (index + 1) * chunkLength);
      pushOutput(
        chunkLength === 1 ? chunk[0] : chunk,
        {
          type: "array",
          len: chunkLength,
          index,
          count: chunkCount,
        },
      );
    }
    return outputs;
  }

  if (isPlainObject(currentValue)) {
    const keys = Object.keys(currentValue);
    const addProperty = normalizeString(nodeConfig?.addname, null);
    keys.forEach((key, index) => {
      const nextMessage = createSdnFlowEditorSplitOutputMessage(
        baseMessage,
        propertyPath,
        cloneJsonCompatibleValue(currentValue[key]),
        {
          type: "object",
          key,
          index,
          count: keys.length,
        },
      );
      if (addProperty) {
        setObjectPathValue(nextMessage, addProperty, key);
      }
      outputs.push(nextMessage);
    });
    return outputs;
  }

  const bufferValue = toSdnFlowEditorSequenceBuffer(currentValue);
  if (!bufferValue) {
    return null;
  }

  const splitType = normalizeString(nodeConfig?.spltType, "str") ?? "str";
  if (splitType === "len") {
    const chunkLength = normalizeSdnFlowEditorSplitChunkLength(nodeConfig?.splt, 1);
    const combinedValue = Buffer.concat([Buffer.from(state.buffer ?? Buffer.alloc(0)), bufferValue]);
    const totalCount = Math.ceil(combinedValue.length / chunkLength);
    if (!stream) {
      state.sequenceIndex = 0;
    }
    let cursor = 0;
    while (cursor + chunkLength < combinedValue.length) {
      pushOutput(
        combinedValue.subarray(cursor, cursor + chunkLength),
        {
          type: "buffer",
          ch: "",
          len: chunkLength,
          index: state.sequenceIndex++,
          ...(stream ? {} : { count: totalCount }),
        },
      );
      cursor += chunkLength;
    }
    const remainder = combinedValue.subarray(cursor);
    state.buffer = Buffer.from(remainder);
    if (remainder.length > 0 && (!stream || remainder.length === chunkLength)) {
      pushOutput(
        remainder,
        {
          type: "buffer",
          ch: "",
          len: chunkLength,
          index: state.sequenceIndex++,
          ...(stream ? {} : { count: totalCount }),
        },
      );
      state.buffer = Buffer.alloc(0);
    }
    if (!stream) {
      state.sequenceIndex = 0;
    }
    return outputs;
  }

  const delimiter =
    splitType === "bin"
      ? parseSdnFlowEditorBinaryControlValue(nodeConfig?.splt)
      : Buffer.from(normalizeSdnFlowEditorSequenceControlString(nodeConfig?.splt, "\n"));
  if (!delimiter || delimiter.length === 0) {
    options.nodeApi?.warn?.("Split delimiter must not be empty.");
    return null;
  }
  const combinedValue = Buffer.concat([Buffer.from(state.buffer ?? Buffer.alloc(0)), bufferValue]);
  const { chunks, remainder } = splitSdnFlowEditorBufferByDelimiter(combinedValue, delimiter);
  chunks.forEach((chunk) => {
    pushOutput(
      chunk,
      {
        type: "buffer",
        ch: Array.from(delimiter),
        index: state.sequenceIndex++,
      },
    );
  });
  if (!stream && remainder.length > 0) {
    pushOutput(
      remainder,
      {
        type: "buffer",
        ch: Array.from(delimiter),
        index: state.sequenceIndex++,
      },
    );
  }
  if (!stream) {
    const count = outputs.length;
    outputs.forEach((entry) => {
      entry.parts.count = count;
    });
    state.buffer = Buffer.alloc(0);
    state.sequenceIndex = 0;
  } else {
    state.buffer = Buffer.from(remainder);
  }
  return outputs;
}

function normalizeSdnFlowEditorJoinMode(nodeConfig = {}) {
  const mode = normalizeString(nodeConfig?.mode, "auto") ?? "auto";
  return mode === "custom" || mode === "reduce" ? mode : "auto";
}

function normalizeSdnFlowEditorJoinTimerMs(nodeConfig = {}, mode = "auto") {
  if (mode === "auto") {
    return 0;
  }
  const seconds = Number.parseFloat(String(nodeConfig?.timeout ?? 0));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function normalizeSdnFlowEditorJoinCount(nodeConfig = {}) {
  if (
    typeof nodeConfig?.count === "number" ||
    (typeof nodeConfig?.count === "string" && nodeConfig.count.trim().length > 0)
  ) {
    const parsed = Number.parseInt(String(nodeConfig.count), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 0;
}

function normalizeSdnFlowEditorJoinStateRecord(record = null) {
  if (record && record.groups instanceof Map) {
    return record;
  }
  return {
    groups: new Map(),
  };
}

function clearSdnFlowEditorJoinGroupTimer(group, clearTimer) {
  if (!group?.timerHandle) {
    return;
  }
  try {
    clearTimer?.(group.timerHandle);
  } catch {
    // Ignore best-effort timer cleanup failures.
  }
  group.timerHandle = null;
}

function cloneSdnFlowEditorJoinPayloadValue(value, payloadType) {
  if (payloadType === "buffer") {
    const bufferValue = toSdnFlowEditorSequenceBuffer(value);
    return bufferValue ? Buffer.from(bufferValue) : value;
  }
  return cloneJsonCompatibleValue(value);
}

function resolveSdnFlowEditorJoinInput(nodeConfig, inputMessage, options = {}) {
  const mode = normalizeSdnFlowEditorJoinMode(nodeConfig);
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };

  if (
    mode === "custom" &&
    normalizeBooleanFlag(nodeConfig?.useparts) !== true &&
    message.parts &&
    typeof message.parts === "object"
  ) {
    if (message.parts.parts && typeof message.parts.parts === "object") {
      message.parts = { parts: cloneJsonCompatibleValue(message.parts.parts) };
    } else {
      delete message.parts;
    }
  }

  if (mode === "auto") {
    if (!message.parts || typeof message.parts !== "object" || !normalizeString(message.parts.id, null)) {
      return {
        mode,
        message,
        missingParts: true,
      };
    }
    const propertyPath = normalizeString(message.parts.property, "payload") ?? "payload";
    return {
      mode,
      message,
      partId: normalizeString(message.parts.id, "_") ?? "_",
      payloadType: normalizeString(message.parts.type, "array") ?? "array",
      targetCount: Number.isFinite(Number(message.parts.count)) ? Number(message.parts.count) : 0,
      joinChar: message.parts.ch,
      propertyKey: message.parts.key,
      arrayLen: Number.isFinite(Number(message.parts.len)) ? Number(message.parts.len) : 0,
      propertyIndex: Number.isFinite(Number(message.parts.index)) ? Number(message.parts.index) : null,
      propertyPath,
      propertyValue: getObjectPathValue(message, propertyPath, undefined),
    };
  }

  if (mode === "reduce") {
    return {
      mode,
      message,
      reduceMode: true,
    };
  }

  const propertyType = normalizeString(nodeConfig?.propertyType, "msg") ?? "msg";
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  let propertyValue = propertyType === "full"
    ? cloneJsonCompatibleValue(message)
    : getObjectPathValue(message, propertyPath, undefined);
  let partId = "_";
  let targetCount = normalizeSdnFlowEditorJoinCount(nodeConfig);
  if (targetCount === 0 && message.parts && typeof message.parts === "object") {
    if (Number.isFinite(Number(message.parts.count))) {
      targetCount = Number(message.parts.count);
    }
    if (normalizeString(message.parts.id, null)) {
      partId = normalizeString(message.parts.id, "_") ?? "_";
    }
  }
  const build = normalizeString(nodeConfig?.build, "array") ?? "array";
  const joinerType = normalizeString(nodeConfig?.joinerType, "str") ?? "str";
  const joinChar =
    joinerType === "bin"
      ? parseSdnFlowEditorBinaryControlValue(nodeConfig?.joiner) ?? Buffer.alloc(0)
      : normalizeSdnFlowEditorSequenceControlString(nodeConfig?.joiner, "\n");
  return {
    mode,
    message,
    partId,
    payloadType: build,
    targetCount,
    joinChar,
    propertyKey:
      build === "object"
        ? getObjectPathValue(message, normalizeString(nodeConfig?.key, "topic") ?? "topic", undefined)
        : undefined,
    arrayLen: 0,
    propertyIndex: null,
    propertyPath,
    propertyValue,
  };
}

function buildCompletedSdnFlowEditorJoinPayload(group) {
  if (group.type === "array") {
    if (group.arrayLen > 1) {
      return group.payload.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
    }
    return cloneJsonCompatibleValue(group.payload);
  }
  if (group.type === "string") {
    const joinChar =
      typeof group.joinChar === "string"
        ? group.joinChar
        : Buffer.from(group.joinChar ?? []).toString();
    return group.payload.map((entry) => entry === undefined ? "" : String(entry)).join(joinChar);
  }
  if (group.type === "buffer") {
    const chunks = group.payload.map((entry) => {
      const bufferValue = toSdnFlowEditorSequenceBuffer(entry);
      return bufferValue ? Buffer.from(bufferValue) : Buffer.from(String(entry ?? ""));
    });
    if (group.joinChar !== undefined) {
      const joinBuffer = typeof group.joinChar === "string"
        ? Buffer.from(group.joinChar)
        : Buffer.from(group.joinChar ?? []);
      return Buffer.concat(
        chunks.flatMap((chunk, index) => (
          index > 0 ? [joinBuffer, chunk] : [chunk]
        )),
      );
    }
    return Buffer.concat(chunks);
  }
  return cloneJsonCompatibleValue(group.payload);
}

function completeSdnFlowEditorJoinGroup(nodeConfig, state, partId, options = {}) {
  const group = state.groups.get(partId);
  if (!group) {
    return null;
  }
  clearSdnFlowEditorJoinGroupTimer(group, options.clearTimer);
  const messageHasComplete = Object.prototype.hasOwnProperty.call(group.msg ?? {}, "complete");
  const outputMessage = cloneJsonCompatibleValue(group.msg);
  setObjectPathValue(outputMessage, group.prop || "payload", buildCompletedSdnFlowEditorJoinPayload(group));
  if (outputMessage.parts && typeof outputMessage.parts === "object" && outputMessage.parts.parts) {
    outputMessage.parts = cloneJsonCompatibleValue(outputMessage.parts.parts);
  } else {
    delete outputMessage.parts;
  }
  delete outputMessage.complete;

  const keepAccumulating =
    normalizeSdnFlowEditorJoinMode(nodeConfig) === "custom" &&
    normalizeBooleanFlag(nodeConfig?.accumulate) === true &&
    messageHasComplete !== true;
  if (!keepAccumulating) {
    state.groups.delete(partId);
  }
  return outputMessage;
}

function scheduleSdnFlowEditorJoinGroupTimeout(nodeConfig, state, partId, options = {}) {
  const timerMs = normalizeSdnFlowEditorJoinTimerMs(nodeConfig, normalizeSdnFlowEditorJoinMode(nodeConfig));
  if (timerMs <= 0 || typeof options.setTimer !== "function") {
    return;
  }
  const group = state.groups.get(partId);
  if (!group) {
    return;
  }
  clearSdnFlowEditorJoinGroupTimer(group, options.clearTimer);
  group.timerHandle = options.setTimer(() => {
    const completed = completeSdnFlowEditorJoinGroup(nodeConfig, state, partId, {
      clearTimer: options.clearTimer,
    });
    if (completed !== null && typeof options.onFlush === "function") {
      try {
        const result = options.onFlush(completed);
        if (result && typeof result.then === "function") {
          void result.catch((error) => {
            options.onError?.(error);
          });
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
  }, timerMs);
}

export function applySdnFlowEditorJoinNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const state = normalizeSdnFlowEditorJoinStateRecord(options.state);
  const joinInput = resolveSdnFlowEditorJoinInput(nodeConfig, inputMessage, options);
  if (joinInput.reduceMode) {
    options.nodeApi?.warn?.("Join reduce mode is not supported yet.");
    return null;
  }

  if (joinInput.missingParts) {
    if (Object.prototype.hasOwnProperty.call(joinInput.message ?? {}, "reset")) {
      for (const [partId, group] of state.groups.entries()) {
        clearSdnFlowEditorJoinGroupTimer(group, options.clearTimer);
        state.groups.delete(partId);
      }
      return null;
    }
    options.nodeApi?.warn?.("Message missing msg.parts property - cannot join in auto mode.");
    return null;
  }

  let group = state.groups.get(joinInput.partId);

  if (Object.prototype.hasOwnProperty.call(joinInput.message ?? {}, "restartTimeout") && group) {
    scheduleSdnFlowEditorJoinGroupTimeout(nodeConfig, state, joinInput.partId, options);
  }

  if (Object.prototype.hasOwnProperty.call(joinInput.message ?? {}, "reset")) {
    if (group) {
      clearSdnFlowEditorJoinGroupTimer(group, options.clearTimer);
      state.groups.delete(joinInput.partId);
    }
    return null;
  }

  if (
    joinInput.payloadType === "object" &&
    (joinInput.propertyKey === null || joinInput.propertyKey === undefined || joinInput.propertyKey === "")
  ) {
    if (normalizeSdnFlowEditorJoinMode(nodeConfig) === "auto") {
      options.nodeApi?.warn?.("Message missing msg.parts.key property - cannot add to object.");
      return null;
    }
    if (Object.prototype.hasOwnProperty.call(joinInput.message ?? {}, "complete") && group) {
      group.msg.complete = joinInput.message.complete;
      return completeSdnFlowEditorJoinGroup(nodeConfig, state, joinInput.partId, {
        clearTimer: options.clearTimer,
      });
    }
    options.nodeApi?.warn?.("Message missing join key property - cannot add to object.");
    return null;
  }

  if (!group) {
    const normalizedType = joinInput.payloadType === "merged" ? "object" : joinInput.payloadType;
    group = {
      currentCount: 0,
      payload:
        normalizedType === "object"
          ? {}
          : [],
      targetCount: joinInput.targetCount,
      type: normalizedType,
      msg: cloneJsonCompatibleValue(joinInput.message),
      prop: joinInput.propertyPath,
      joinChar:
        normalizedType === "string" || normalizedType === "buffer"
          ? joinInput.joinChar
          : undefined,
      arrayLen: joinInput.arrayLen,
      timerHandle: null,
    };
    state.groups.set(joinInput.partId, group);
    scheduleSdnFlowEditorJoinGroupTimeout(nodeConfig, state, joinInput.partId, options);
  }

  if (joinInput.payloadType === "object") {
    group.payload[joinInput.propertyKey] = cloneJsonCompatibleValue(joinInput.propertyValue);
    group.currentCount = Object.keys(group.payload).length;
  } else if (joinInput.payloadType === "merged") {
    if (!isPlainObject(joinInput.propertyValue)) {
      if (!Object.prototype.hasOwnProperty.call(joinInput.message ?? {}, "complete")) {
        options.nodeApi?.warn?.("Cannot merge non-object types.");
      }
    } else {
      for (const [key, value] of Object.entries(joinInput.propertyValue)) {
        if (key === "_msgid") {
          continue;
        }
        group.payload[key] = cloneJsonCompatibleValue(value);
      }
      group.currentCount = Object.keys(group.payload).length;
    }
  } else if (joinInput.propertyIndex !== null && joinInput.propertyIndex !== undefined) {
    if (group.payload[joinInput.propertyIndex] === undefined) {
      group.currentCount += 1;
    }
    group.payload[joinInput.propertyIndex] = cloneSdnFlowEditorJoinPayloadValue(
      joinInput.propertyValue,
      joinInput.payloadType,
    );
  } else if (joinInput.propertyValue !== undefined) {
    group.payload.push(
      cloneSdnFlowEditorJoinPayloadValue(joinInput.propertyValue, joinInput.payloadType),
    );
    group.currentCount += 1;
  }

  group.msg = {
    ...group.msg,
    ...cloneJsonCompatibleValue(joinInput.message),
  };
  if (joinInput.targetCount > 0) {
    group.targetCount = joinInput.targetCount;
  }

  if (
    (group.targetCount > 0 && group.currentCount >= group.targetCount) ||
    Object.prototype.hasOwnProperty.call(joinInput.message ?? {}, "complete")
  ) {
    return completeSdnFlowEditorJoinGroup(nodeConfig, state, joinInput.partId, {
      clearTimer: options.clearTimer,
    });
  }

  return null;
}

function normalizeSdnFlowEditorBatchMode(nodeConfig = {}) {
  return normalizeString(nodeConfig?.mode, "count") ?? "count";
}

function normalizeSdnFlowEditorBatchStateRecord(record = null) {
  if (record && typeof record === "object") {
    return record;
  }
  return {
    countQueue: [],
    intervalQueue: [],
    concatPending: new Map(),
    intervalHandle: null,
  };
}

function cloneSdnFlowEditorBatchMessageSequence(messages = []) {
  const normalizedMessages = asArray(messages).map((message) => cloneJsonCompatibleValue(message));
  if (normalizedMessages.length === 0) {
    return [];
  }
  const partsId =
    normalizeString(normalizedMessages[0]?._msgid, null) ?? randomUUID().replaceAll("-", "");
  return normalizedMessages.map((message, index) => {
    const nextMessage = cloneJsonCompatibleValue(message);
    nextMessage.parts = {
      ...(isPlainObject(nextMessage.parts) ? nextMessage.parts : {}),
      id: partsId,
      index,
      count: normalizedMessages.length,
    };
    return nextMessage;
  });
}

function clearSdnFlowEditorBatchConcatPending(state) {
  state.concatPending = new Map();
}

function flushSdnFlowEditorBatchIntervalQueue(nodeConfig = {}, state = {}) {
  const queuedMessages = asArray(state.intervalQueue);
  if (queuedMessages.length > 0) {
    state.intervalQueue = [];
    return cloneSdnFlowEditorBatchMessageSequence(queuedMessages);
  }
  if (normalizeBooleanFlag(nodeConfig?.allowEmptySequence)) {
    return [
      {
        payload: null,
        parts: {
          id: randomUUID().replaceAll("-", ""),
          index: 0,
          count: 1,
        },
      },
    ];
  }
  return null;
}

function dispatchSdnFlowEditorBatchFlush(result, options = {}) {
  if (!result || typeof options.onFlush !== "function") {
    return;
  }
  try {
    const flushResult = options.onFlush(result);
    if (flushResult && typeof flushResult.then === "function") {
      void flushResult.catch((error) => {
        options.onError?.(error);
      });
    }
  } catch (error) {
    options.onError?.(error);
  }
}

function restartSdnFlowEditorBatchInterval(nodeConfig = {}, state = {}, options = {}) {
  if (state.intervalHandle) {
    try {
      options.clearInterval?.(state.intervalHandle);
    } catch {
      // Ignore best-effort timer cleanup failures.
    }
    state.intervalHandle = null;
  }
  const intervalMs = Math.max(1, Math.round(normalizeNumber(nodeConfig?.interval, 10) * 1000));
  if (typeof options.setInterval !== "function" || intervalMs <= 0) {
    return;
  }
  state.intervalHandle = options.setInterval(() => {
    const result = flushSdnFlowEditorBatchIntervalQueue(nodeConfig, state);
    dispatchSdnFlowEditorBatchFlush(result, options);
  }, intervalMs);
}

function addSdnFlowEditorBatchConcatMessage(state, topic, message) {
  let topicRecord = state.concatPending.get(topic);
  if (!topicRecord) {
    topicRecord = {
      groups: new Map(),
      order: [],
    };
    state.concatPending.set(topic, topicRecord);
  }
  const groupId = normalizeString(message?.parts?.id, null);
  if (!groupId) {
    return;
  }
  let group = topicRecord.groups.get(groupId);
  if (!group) {
    group = {
      messages: [],
      count: Number.isFinite(Number(message?.parts?.count)) ? Number(message.parts.count) : 0,
    };
    topicRecord.groups.set(groupId, group);
    topicRecord.order.push(groupId);
  }
  if (Number.isFinite(Number(message?.parts?.count))) {
    group.count = Number(message.parts.count);
  }
  group.messages.push(cloneJsonCompatibleValue(message));
}

function isSdnFlowEditorBatchConcatTopicReady(state, topic) {
  const topicRecord = state.concatPending.get(topic);
  if (!topicRecord || topicRecord.order.length === 0) {
    return false;
  }
  const group = topicRecord.groups.get(topicRecord.order[0]);
  return Boolean(group && group.count > 0 && group.messages.length >= group.count);
}

function removeSdnFlowEditorBatchConcatTopicHead(state, topic) {
  const topicRecord = state.concatPending.get(topic);
  if (!topicRecord || topicRecord.order.length === 0) {
    return [];
  }
  const groupId = topicRecord.order.shift();
  const group = topicRecord.groups.get(groupId);
  topicRecord.groups.delete(groupId);
  return asArray(group?.messages).map((message) => cloneJsonCompatibleValue(message));
}

export function applySdnFlowEditorBatchNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const state = normalizeSdnFlowEditorBatchStateRecord(options.state);
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const mode = normalizeSdnFlowEditorBatchMode(nodeConfig);

  if (mode === "count") {
    if (Object.prototype.hasOwnProperty.call(message, "reset")) {
      state.countQueue = [];
      return null;
    }
    state.countQueue.push(message);
    const count = Math.max(1, Math.floor(normalizeNumber(nodeConfig?.count, 1)));
    const overlap = Math.max(0, Math.floor(normalizeNumber(nodeConfig?.overlap, 0)));
    const honourParts = normalizeBooleanFlag(nodeConfig?.honourParts);
    const parts = isPlainObject(message.parts) ? message.parts : null;
    const endOfSequence =
      honourParts &&
      Number.isFinite(Number(parts?.count)) &&
      Number.isFinite(Number(parts?.index)) &&
      Number(parts.index) + 1 >= Number(parts.count);
    if (state.countQueue.length >= count || endOfSequence) {
      const queuedMessages = state.countQueue.map((entry) => cloneJsonCompatibleValue(entry));
      const emitted = cloneSdnFlowEditorBatchMessageSequence(queuedMessages);
      state.countQueue =
        overlap > 0
          ? queuedMessages.slice(-overlap).map((entry) => cloneJsonCompatibleValue(entry))
          : [];
      return emitted;
    }
    return null;
  }

  if (mode === "interval") {
    if (!state.intervalHandle) {
      restartSdnFlowEditorBatchInterval(nodeConfig, state, options);
    }
    if (Object.prototype.hasOwnProperty.call(message, "reset")) {
      state.intervalQueue = [];
      restartSdnFlowEditorBatchInterval(nodeConfig, state, options);
      return null;
    }
    state.intervalQueue.push(message);
    return null;
  }

  if (mode === "concat") {
    if (Object.prototype.hasOwnProperty.call(message, "reset")) {
      clearSdnFlowEditorBatchConcatPending(state);
      return null;
    }
    const topics = asArray(nodeConfig?.topics)
      .map((entry) => normalizeString(entry?.topic, null))
      .filter(Boolean);
    const topic = normalizeString(message?.topic, null);
    if (!topic || !topics.includes(topic)) {
      return null;
    }
    if (
      !isPlainObject(message.parts) ||
      !normalizeString(message.parts.id, null) ||
      !Number.isFinite(Number(message.parts.index)) ||
      !Number.isFinite(Number(message.parts.count))
    ) {
      options.nodeApi?.warn?.("Batch concat mode requires msg.topic and complete msg.parts metadata.");
      return null;
    }
    addSdnFlowEditorBatchConcatMessage(state, topic, message);
    if (!topics.every((configuredTopic) => isSdnFlowEditorBatchConcatTopicReady(state, configuredTopic))) {
      return null;
    }
    const combinedMessages = topics.flatMap((configuredTopic) =>
      removeSdnFlowEditorBatchConcatTopicHead(state, configuredTopic)
    );
    return cloneSdnFlowEditorBatchMessageSequence(combinedMessages);
  }

  options.nodeApi?.warn?.(`Unsupported batch mode "${mode}".`);
  return null;
}

function normalizeSdnFlowEditorFileEncoding(nodeConfig = {}, message = {}) {
  const encoding = normalizeString(nodeConfig?.encoding, "none") ?? "none";
  if (encoding === "setbymsg") {
    return normalizeString(message?.encoding, "none") ?? "none";
  }
  return encoding;
}

function encodeSdnFlowEditorFilePayload(payload, encoding = "none") {
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }
  const existingBytes = toByteArray(payload);
  if (existingBytes) {
    return Buffer.from(existingBytes);
  }
  let textPayload = payload;
  if (typeof textPayload === "object" && textPayload !== null) {
    textPayload = JSON.stringify(textPayload);
  }
  if (typeof textPayload === "boolean" || typeof textPayload === "number") {
    textPayload = String(textPayload);
  }
  const normalizedText = String(textPayload ?? "");
  if (encoding !== "none") {
    return iconv.encode(normalizedText, encoding);
  }
  return Buffer.from(normalizedText);
}

function decodeSdnFlowEditorFilePayload(bufferValue, encoding = "none") {
  const bytes = Buffer.from(bufferValue ?? Buffer.alloc(0));
  if (encoding !== "none") {
    return iconv.decode(bytes, encoding);
  }
  return bytes.toString();
}

function evaluateSdnFlowEditorFileName(nodeConfig = {}, inputMessage = {}, options = {}) {
  const filenameType = normalizeString(nodeConfig?.filenameType, "str") ?? "str";
  if (filenameType === "jsonata") {
    options.nodeApi?.warn?.("File JSONata filenames are not supported yet.");
    return null;
  }
  const rawValue = evaluateTypedInputValue(nodeConfig?.filename, filenameType, {
    env: options.env,
    flow: options.flow,
    global: options.global,
    msg: inputMessage,
  });
  if (rawValue === null || rawValue === undefined) {
    return "";
  }
  return String(rawValue).replace(/\t|\r|\n/g, "");
}

function resolveSdnFlowEditorFileSystemPath(fileName, options = {}) {
  const normalizedFileName = normalizeString(fileName, "") ?? "";
  if (!normalizedFileName) {
    return "";
  }
  if (path.isAbsolute(normalizedFileName)) {
    return normalizedFileName;
  }
  const workingDirectory =
    normalizeString(options.workingDirectory, null) ??
    normalizeString(options.projectRoot, null) ??
    process.cwd();
  return path.resolve(path.join(workingDirectory, normalizedFileName));
}

function createSdnFlowEditorFileChunkBase(message, allProps) {
  if (allProps) {
    return cloneJsonCompatibleValue(message);
  }
  return {
    topic: cloneJsonCompatibleValue(message?.topic),
    filename: cloneJsonCompatibleValue(message?.filename),
  };
}

export async function applySdnFlowEditorFileNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const fileName = evaluateSdnFlowEditorFileName(nodeConfig, message, options);
  if (!fileName) {
    options.nodeApi?.warn?.("No filename specified.");
    return null;
  }
  const fileSystemPath = resolveSdnFlowEditorFileSystemPath(fileName, options);
  const outputMessage = cloneJsonCompatibleValue(message);
  outputMessage.filename = fileName;
  const action = normalizeString(nodeConfig?.overwriteFile, "false") ?? "false";

  try {
    if (action === "delete") {
      await fs.unlink(fileSystemPath);
      return outputMessage;
    }

    if (!Object.prototype.hasOwnProperty.call(message, "payload") || message.payload === undefined) {
      return null;
    }

    if (normalizeBooleanFlag(nodeConfig?.createDir)) {
      await fs.mkdir(path.dirname(fileSystemPath), { recursive: true });
    }

    let payload = message.payload;
    const shouldAppendNewline =
      normalizeBooleanFlag(nodeConfig?.appendNewline) &&
      !(payload instanceof Uint8Array) &&
      !Buffer.isBuffer(payload) &&
      !(
        isPlainObject(message.parts) &&
        normalizeString(message.parts.type, null) === "string" &&
        Number.isFinite(Number(message.parts.count)) &&
        Number.isFinite(Number(message.parts.index)) &&
        Number(message.parts.index) + 1 >= Number(message.parts.count)
      );
    if (shouldAppendNewline) {
      payload = `${typeof payload === "string" ? payload : String(payload ?? "")}${os.EOL}`;
    }
    const encodedPayload = encodeSdnFlowEditorFilePayload(
      payload,
      normalizeSdnFlowEditorFileEncoding(nodeConfig, message),
    );
    if (action === "true") {
      await fs.writeFile(fileSystemPath, encodedPayload);
    } else {
      await fs.appendFile(fileSystemPath, encodedPayload);
    }
    return outputMessage;
  } catch (error) {
    options.nodeApi?.error?.(formatErrorMessage(error));
    return null;
  }
}

export async function applySdnFlowEditorFileInNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const fileName = evaluateSdnFlowEditorFileName(nodeConfig, message, options);
  if (!fileName) {
    options.nodeApi?.warn?.("No filename specified.");
    return null;
  }
  const fileSystemPath = resolveSdnFlowEditorFileSystemPath(fileName, options);
  message.filename = fileName;
  const format = normalizeString(nodeConfig?.format, "utf8") ?? "utf8";
  const encoding = normalizeSdnFlowEditorFileEncoding(nodeConfig, message);
  const allProps = normalizeBooleanFlag(nodeConfig?.allProps);

  try {
    const bufferValue = await fs.readFile(fileSystemPath);
    if (format === "utf8") {
      message.payload = decodeSdnFlowEditorFilePayload(bufferValue, encoding);
      return message;
    }
    if (!format) {
      message.payload = Buffer.from(bufferValue);
      return message;
    }
    const partsId = normalizeString(message?._msgid, null) ?? randomUUID().replaceAll("-", "");
    if (format === "lines") {
      const textValue = decodeSdnFlowEditorFilePayload(bufferValue, encoding);
      const lines = textValue.split("\n");
      return lines.map((line, index) => {
        const nextMessage = createSdnFlowEditorFileChunkBase(message, allProps);
        nextMessage.payload = line;
        nextMessage.parts = {
          id: partsId,
          index,
          count: lines.length,
          ch: "\n",
          type: "string",
        };
        return nextMessage;
      });
    }
    if (format === "stream") {
      const chunkSize = 64 * 1024;
      const outputs = [];
      const chunkCount = Math.max(1, Math.ceil(bufferValue.length / chunkSize));
      for (let index = 0; index < chunkCount; index += 1) {
        const nextMessage = createSdnFlowEditorFileChunkBase(message, allProps);
        nextMessage.payload = Buffer.from(
          bufferValue.subarray(index * chunkSize, Math.min(bufferValue.length, (index + 1) * chunkSize)),
        );
        nextMessage.parts = {
          id: partsId,
          index,
          count: chunkCount,
          ch: "",
          type: "buffer",
        };
        outputs.push(nextMessage);
      }
      return outputs;
    }
    message.payload = Buffer.from(bufferValue);
    return message;
  } catch (error) {
    options.nodeApi?.error?.(formatErrorMessage(error));
    if (nodeConfig?.sendError === true || nodeConfig?.sendError === "true") {
      const errorMessage = cloneJsonCompatibleValue(message);
      delete errorMessage.payload;
      errorMessage.error = {
        message: formatErrorMessage(error),
      };
      return errorMessage;
    }
    return null;
  }
}

export function applySdnFlowEditorCsvNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const state = options.state ?? { hdrSent: false };
  if (Object.prototype.hasOwnProperty.call(message, "reset")) {
    state.hdrSent = false;
  }

  const currentValue = getObjectPathValue(message, "payload", undefined);
  if (currentValue === undefined) {
    return Object.prototype.hasOwnProperty.call(message, "reset") ? null : message;
  }

  const separator = normalizeSdnFlowEditorCsvControlString(nodeConfig?.sep, ",");
  const quote = "\"";
  const newline = normalizeSdnFlowEditorCsvControlString(nodeConfig?.ret, "\r\n");
  const multi = normalizeString(nodeConfig?.multi, "one") ?? "one";
  const skip = Math.max(0, Math.floor(normalizeNumber(nodeConfig?.skip, 0)));
  const headerIn = normalizeBooleanFlag(nodeConfig?.hdrin);
  const headerOut = normalizeString(nodeConfig?.hdrout, "none") ?? "none";
  const includeEmptyStrings = normalizeBooleanFlag(nodeConfig?.include_empty_strings);
  const includeNullValues = normalizeBooleanFlag(nodeConfig?.include_null_values);
  const parseNumeric = nodeConfig?.strings === undefined ? true : normalizeBooleanFlag(nodeConfig?.strings);

  let configuredTemplate = [];
  try {
    configuredTemplate = parseSdnFlowEditorCsvTemplate(nodeConfig?.temp ?? "");
  } catch (error) {
    options.nodeApi?.warn?.(`Malformed columns template: ${error.message}`);
    return null;
  }

  if (typeof currentValue === "string") {
    const parsedRows = parseSdnFlowEditorCsvRows(currentValue, {
      separator,
      quote,
      strict: false,
    });
    const candidateRows = parsedRows.slice(skip);
    let headers = [...configuredTemplate];
    const dataRows = [...candidateRows];
    if (headerIn) {
      headers = dataRows.shift() ?? [];
    } else {
      headers = ensureSdnFlowEditorCsvHeaders(headers, dataRows[0] ?? null);
    }

    const parsedObjects = [];
    for (const row of dataRows) {
      const rowObject = {};
      let empty = true;
      for (let index = 0; index < headers.length; index += 1) {
        const header = headers[index];
        if (!header) {
          continue;
        }
        let cellValue = row[index] === undefined ? null : row[index];
        if (cellValue === null && !includeNullValues) {
          continue;
        }
        if (cellValue === "" && !includeEmptyStrings) {
          continue;
        }
        if (shouldCoerceSdnFlowEditorCsvNumber(cellValue) && parseNumeric) {
          cellValue = +cellValue;
        }
        rowObject[header] = cellValue;
        empty = false;
      }
      if (!empty) {
        parsedObjects.push(rowObject);
      }
    }

    const columns = formatSdnFlowEditorCsvColumns(headers);
    if (multi !== "one") {
      message.payload = parsedObjects;
      message.columns = columns;
      return message;
    }

    const partsId = normalizeString(message?._msgid, null) ?? randomUUID().replaceAll("-", "");
    return parsedObjects.map((rowObject, index) => {
      const nextMessage = cloneJsonCompatibleValue(message);
      nextMessage.payload = rowObject;
      nextMessage.columns = columns;
      nextMessage.parts = {
        id: partsId,
        index,
        count: parsedObjects.length,
      };
      return nextMessage;
    });
  }

  if (!Array.isArray(currentValue) && !isPlainObject(currentValue)) {
    options.nodeApi?.warn?.("This node only handles CSV strings or js objects.");
    return null;
  }

  const inputRows = !Array.isArray(currentValue)
    ? [cloneJsonCompatibleValue(currentValue)]
    : cloneJsonCompatibleValue(currentValue);
  let headers = [...configuredTemplate];
  if (headers.length === 0 && typeof message.columns === "string" && message.columns.length > 0) {
    try {
      headers = parseSdnFlowEditorCsvTemplate(message.columns);
    } catch {
      headers = [];
    }
  }
  headers = ensureSdnFlowEditorCsvHeaders(headers, inputRows[0] ?? null);

  const stringRows = [];
  const shouldSendHeaders =
    headerOut !== "none" &&
    (headerOut === "all" || state.hdrSent !== true);
  if (shouldSendHeaders && headers.length > 0) {
    stringRows.push(
      formatSdnFlowEditorCsvColumns(headers, {
        separator,
        keepEmptyColumns: true,
      }),
    );
    if (headerOut === "once") {
      state.hdrSent = true;
    }
  }

  for (const row of inputRows) {
    if (Array.isArray(row)) {
      const rowValues = [];
      const length = headers.length > 0 ? headers.length : row.length;
      for (let index = 0; index < length; index += 1) {
        if (headers.length > 0 && !headers[index]) {
          rowValues.push("");
          continue;
        }
        const cellValue = row[index] === undefined || row[index] === null ? "" : String(row[index]);
        rowValues.push(
          quoteSdnFlowEditorCsvCell(cellValue, {
            separator,
            quote,
          }),
        );
      }
      stringRows.push(rowValues.join(separator));
      continue;
    }

    if (isPlainObject(row)) {
      const rowValues = [];
      for (const header of headers) {
        if (!header) {
          rowValues.push("");
          continue;
        }
        const cellValue = row[header] === undefined || row[header] === null ? "" : String(row[header]);
        rowValues.push(
          quoteSdnFlowEditorCsvCell(cellValue, {
            separator,
            quote,
          }),
        );
      }
      stringRows.push(rowValues.join(separator));
    }
  }

  const payload = stringRows.length > 0 ? `${stringRows.join(newline)}${newline}` : "";
  if (!payload) {
    return null;
  }
  message.payload = payload;
  message.columns = formatSdnFlowEditorCsvColumns(headers);
  return message;
}

export function applySdnFlowEditorYamlNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  const currentValue = getObjectPathValue(message, propertyPath, undefined);
  if (currentValue === undefined) {
    return message;
  }

  if (typeof currentValue === "string") {
    setObjectPathValue(message, propertyPath, yaml.load(currentValue));
    return message;
  }

  if (currentValue !== null && typeof currentValue === "object") {
    if (toByteArray(currentValue)) {
      options.nodeApi?.warn?.("Ignored non-object payload");
      return null;
    }
    try {
      setObjectPathValue(message, propertyPath, yaml.dump(currentValue));
      return message;
    } catch {
      options.nodeApi?.warn?.("Failed to convert payload");
      return null;
    }
  }

  options.nodeApi?.warn?.("Ignored unsupported payload type");
  return null;
}

export async function applySdnFlowEditorXmlNodeMessage(nodeConfig = {}, inputMessage = {}, options = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  const currentValue = getObjectPathValue(message, propertyPath, undefined);
  if (currentValue === undefined) {
    return message;
  }

  if (currentValue !== null && typeof currentValue === "object") {
    const builderOptions =
      isPlainObject(message.options)
        ? { ...message.options }
        : { renderOpts: { pretty: false } };
    builderOptions.async = false;
    const builder = new xml2js.Builder(builderOptions);
    setObjectPathValue(message, propertyPath, builder.buildObject(currentValue));
    return message;
  }

  if (typeof currentValue === "string") {
    const parseOptions = isPlainObject(message.options) ? { ...message.options } : {};
    parseOptions.async = true;
    parseOptions.attrkey = normalizeString(nodeConfig?.attr, parseOptions.attrkey) ?? parseOptions.attrkey ?? "$";
    parseOptions.charkey = normalizeString(nodeConfig?.chr, parseOptions.charkey) ?? parseOptions.charkey ?? "_";
    const parsedValue = await new Promise((resolve, reject) => {
      xml2js.parseString(currentValue, parseOptions, (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      });
    });
    setObjectPathValue(message, propertyPath, parsedValue);
    return message;
  }

  options.nodeApi?.warn?.("This node only handles xml strings or js objects.");
  return null;
}

function buildSdnFlowEditorHtmlNodeOutput($, element, outputType, chr) {
  if (outputType === "html") {
    return cheerio.load($(element).html().trim(), null, false).xml();
  }
  if (outputType === "text") {
    return $(element).text();
  }
  if (outputType === "attr") {
    return Object.assign({}, element.attribs);
  }
  if (outputType === "compl") {
    const base = {};
    base[chr] = $(element).html().trim();
    return Object.assign(base, element.attribs);
  }
  return null;
}

export function applySdnFlowEditorHtmlNodeMessage(nodeConfig = {}, inputMessage = {}) {
  const message =
    inputMessage && typeof inputMessage === "object" && !Array.isArray(inputMessage)
      ? cloneJsonCompatibleValue(inputMessage)
      : { payload: inputMessage };
  const propertyPath = normalizeString(nodeConfig?.property, "payload") ?? "payload";
  const outputProperty =
    normalizeString(nodeConfig?.outproperty, propertyPath) ??
    propertyPath;
  const currentValue = getObjectPathValue(message, propertyPath, undefined);
  if (currentValue === undefined) {
    return message;
  }

  let selector = normalizeString(nodeConfig?.tag, "") ?? "";
  if (Object.prototype.hasOwnProperty.call(message, "select")) {
    selector = nodeConfig?.tag || message.select;
  }

  const outputType = normalizeString(nodeConfig?.ret, "html") ?? "html";
  const outputMode = normalizeString(nodeConfig?.as, "single") ?? "single";
  const chr = normalizeString(nodeConfig?.chr, "_") ?? "_";
  const $ = cheerio.load(currentValue);

  if (outputMode === "multi") {
    const outputMessages = [];
    const count = $(selector).length;
    let index = 0;
    $(selector).each((_, element) => {
      const nextValue = buildSdnFlowEditorHtmlNodeOutput($, element, outputType, chr);
      if (nextValue) {
        const nextMessage = cloneJsonCompatibleValue(message);
        setObjectPathValue(nextMessage, outputProperty, nextValue);
        nextMessage.parts = {
          id: message?._msgid,
          index,
          count,
          type: "string",
          ch: "",
        };
        outputMessages.push(nextMessage);
      }
      index += 1;
    });
    return outputMessages;
  }

  const outputValues = [];
  $(selector).each((_, element) => {
    outputValues.push(buildSdnFlowEditorHtmlNodeOutput($, element, outputType, chr));
  });
  setObjectPathValue(message, outputProperty, outputValues);
  return message;
}

function buildInjectMessage(node = {}, options = {}, override = null) {
  const message = {
    _msgid: randomUUID().replaceAll("-", ""),
  };
  const overrideProps = asArray(override?.__user_inject_props__).filter(
    (entry) => entry && typeof entry === "object",
  );
  const props = overrideProps.length > 0
    ? overrideProps
    : asArray(node.props).length > 0
      ? asArray(node.props)
    : [
        {
          p: "payload",
          v: node.payload,
          vt: node.payloadType ?? "date",
        },
        {
          p: "topic",
          v: node.topic ?? "",
          vt: "str",
        },
      ];
  for (const prop of props) {
    const propertyPath = normalizeString(prop?.p, null);
    if (!propertyPath) {
      continue;
    }
    const valueType = normalizeString(
      prop?.vt,
      propertyPath === "payload" ? node.payloadType ?? "date" : "str",
    );
    const rawValue = prop?.v ?? (propertyPath === "payload" ? node.payload : node[propertyPath]);
    setObjectPathValue(
      message,
      propertyPath,
      evaluateTypedInputValue(rawValue, valueType, options),
    );
  }
  if (isPlainObject(override)) {
    for (const [key, value] of Object.entries(override)) {
      if (key === "__user_inject_props__") {
        continue;
      }
      message[key] = cloneJsonCompatibleValue(value);
    }
  }
  return message;
}

function normalizeOutputMessages(value) {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeOutputMessages(entry));
  }
  return [value];
}

function createOutputFrames(slotValue, portId) {
  return normalizeOutputMessages(slotValue).map((message) => {
    const normalizedMessage =
      message && typeof message === "object" && !Array.isArray(message)
        ? cloneJsonCompatibleValue(message)
        : { payload: message };
    return {
      portId,
      typeRef: SDN_FLOW_EDITOR_RUNTIME_MESSAGE_TYPE,
      bytes: encodeRuntimePayload(normalizedMessage),
      metadata: {
        payloadType: inferDebugFormat(normalizedMessage?.payload),
      },
    };
  });
}

function createDebugEventPayload(node, message) {
  const targetType = normalizeString(node?.targetType, "msg");
  const complete = node?.complete === true || node?.complete === "true"
    ? "msg"
    : normalizeString(node?.complete, "payload");
  const debugValue =
    targetType === "full" || complete === "msg"
      ? cloneJsonCompatibleValue(message)
      : cloneJsonCompatibleValue(getObjectPathValue(message, complete, null));
  return {
    id: normalizeString(node?.id, null),
    name: normalizeString(node?.name, "debug"),
    topic: normalizeString(message?.topic, ""),
    msg: debugValue,
    format: inferDebugFormat(debugValue),
    path: normalizeString(node?.z, null),
  };
}

function evaluateSwitchRule(input, rule = {}, options = {}) {
  const operator = normalizeString(rule?.t, "else") ?? "else";
  const left = getObjectPathValue(input, rule?.p ?? options.propertyPath, null);
  const right = evaluateTypedInputValue(rule?.v, rule?.vt ?? "str", {
    env: options.env,
    msg: input,
  });
  switch (operator) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "bt": {
      const high = evaluateTypedInputValue(rule?.v2, rule?.v2t ?? rule?.vt ?? "str", {
        env: options.env,
        msg: input,
      });
      return Number(left) >= Number(right) && Number(left) <= Number(high);
    }
    case "cont":
      return String(left ?? "").includes(String(right ?? ""));
    case "true":
      return left === true;
    case "false":
      return left === false;
    case "null":
      return left === null || left === undefined;
    case "nnull":
      return left !== null && left !== undefined;
    case "empty":
      return left === "" || (Array.isArray(left) && left.length === 0);
    case "nempty":
      return !(left === "" || (Array.isArray(left) && left.length === 0));
    case "regex":
      try {
        return new RegExp(String(rule?.v ?? "")).test(String(left ?? ""));
      } catch {
        return false;
      }
    case "else":
    default:
      return true;
  }
}

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeBooleanFlag(value) {
  return value === true || value === "true";
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number.parseFloat(String(value ?? fallback));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createSdnFlowEditorRuntimeHttpError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeHttpRequestMethod(value, fallback = "GET") {
  return (normalizeString(value, fallback) ?? fallback).toUpperCase();
}

function normalizeHttpNodeMethod(value, fallback = "get") {
  return (normalizeString(value, fallback) ?? fallback).toLowerCase();
}

function normalizeHttpRoutePath(value) {
  const normalized = normalizeString(value, "/") ?? "/";
  if (normalized === "/") {
    return "/";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function normalizeHttpPathSegments(pathValue) {
  return normalizeHttpRoutePath(pathValue)
    .split("/")
    .filter(Boolean);
}

function decodeHttpPathSegment(value) {
  try {
    return decodeURIComponent(String(value ?? ""));
  } catch {
    return String(value ?? "");
  }
}

function matchHttpRoutePath(patternPath, requestPath) {
  const normalizedPattern = normalizeHttpRoutePath(patternPath);
  const normalizedRequest = normalizeHttpRoutePath(requestPath);
  if (normalizedPattern === normalizedRequest) {
    return {};
  }
  const patternSegments = normalizeHttpPathSegments(normalizedPattern);
  const requestSegments = normalizeHttpPathSegments(normalizedRequest);
  if (patternSegments.length !== requestSegments.length) {
    return null;
  }
  const params = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const requestSegment = requestSegments[index];
    if (patternSegment.startsWith(":") && patternSegment.length > 1) {
      params[patternSegment.slice(1)] = decodeHttpPathSegment(requestSegment);
      continue;
    }
    if (patternSegment !== requestSegment) {
      return null;
    }
  }
  return params;
}

function doesHttpMethodMatch(nodeMethod, requestMethod) {
  const normalizedNodeMethod = normalizeHttpNodeMethod(nodeMethod, "get");
  const normalizedRequestMethod = normalizeHttpNodeMethod(requestMethod, "get");
  return normalizedNodeMethod === normalizedRequestMethod ||
    (normalizedRequestMethod === "head" && normalizedNodeMethod === "get");
}

function normalizeHttpHeaderRecord(target = {}, headers = {}) {
  if (!headers) {
    return target;
  }
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      normalizeHttpHeaderRecord(target, [[key, value]]);
    });
    return target;
  }
  if (typeof headers.entries === "function") {
    return normalizeHttpHeaderRecord(target, Array.from(headers.entries()));
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length >= 2) {
        const headerName = normalizeString(entry[0], null);
        const headerValue = entry[1];
        if (headerName && headerValue !== undefined && headerValue !== null) {
          target[headerName.toLowerCase()] = Array.isArray(headerValue)
            ? headerValue.map((item) => String(item)).join(", ")
            : String(headerValue);
        }
        continue;
      }
      if (isPlainObject(entry)) {
        normalizeHttpHeaderRecord(target, entry);
      }
    }
    return target;
  }
  if (isPlainObject(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      const headerName = normalizeString(key, null);
      if (!headerName || value === undefined || value === null) {
        continue;
      }
      target[headerName.toLowerCase()] = Array.isArray(value)
        ? value.map((item) => String(item)).join(", ")
        : String(value);
    }
  }
  return target;
}

function resolveConfiguredHttpHeaderValue(typeValue, rawValue, inputMessage) {
  const normalizedType = normalizeString(typeValue, null);
  if (normalizedType === "msg") {
    const resolved = getObjectPathValue(inputMessage ?? {}, rawValue, null);
    if (resolved === undefined || resolved === null) {
      return null;
    }
    return Array.isArray(resolved) ? resolved.map((entry) => String(entry)).join(", ") : String(resolved);
  }
  if (normalizedType === "other") {
    return normalizeString(rawValue, null);
  }
  if (normalizedType) {
    return normalizedType;
  }
  if (rawValue === undefined || rawValue === null) {
    return null;
  }
  return String(rawValue);
}

function normalizeConfiguredHttpHeaders(configuredHeaders, inputMessage = {}) {
  if (Array.isArray(configuredHeaders)) {
    const normalized = {};
    for (const header of configuredHeaders) {
      if (!isPlainObject(header)) {
        continue;
      }
      const headerName = resolveConfiguredHttpHeaderValue(
        header.keyType ?? header.hType ?? header.key_type,
        header.keyValue ?? header.h ?? header.key_value,
        inputMessage,
      );
      const headerValue = resolveConfiguredHttpHeaderValue(
        header.valueType ?? header.vType ?? header.value_type,
        header.valueValue ?? header.v ?? header.value_value,
        inputMessage,
      );
      if (headerName && headerValue !== null) {
        normalized[headerName.toLowerCase()] = headerValue;
      }
    }
    return normalized;
  }
  return normalizeHttpHeaderRecord({}, configuredHeaders);
}

function parseHttpRequestPayload(bodyValue, nodeConfig = {}, headers = {}) {
  const bodyBytes = toByteArray(bodyValue);
  if (!bodyBytes || bodyBytes.length === 0) {
    return null;
  }
  if (normalizeBooleanFlag(nodeConfig?.skipBodyParsing)) {
    return Array.from(bodyBytes);
  }
  const contentType = normalizeString(headers["content-type"], "")?.toLowerCase() ?? "";
  const bodyText = textDecoder.decode(bodyBytes);
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(bodyText);
    } catch {
      return bodyText;
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(bodyText).entries());
  }
  if (
    contentType.startsWith("text/") ||
    contentType.includes("xml") ||
    contentType.includes("yaml") ||
    contentType.includes("javascript") ||
    contentType.includes("svg")
  ) {
    return bodyText;
  }
  return Array.from(bodyBytes);
}

function buildHttpRequestPathWithQuery(pathValue, query = {}) {
  const pathname = normalizeHttpRoutePath(pathValue);
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(isPlainObject(query) ? query : {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        searchParams.append(key, String(entry));
      }
      continue;
    }
    searchParams.set(key, String(value));
  }
  const queryString = searchParams.toString();
  return queryString.length > 0 ? `${pathname}?${queryString}` : pathname;
}

function normalizeHttpResponseStatusCode(...values) {
  for (const candidate of values) {
    const numeric = Number.parseInt(String(candidate ?? ""), 10);
    if (Number.isInteger(numeric) && numeric >= 100) {
      return numeric;
    }
  }
  return 200;
}

function normalizeHttpResponsePayloadData(payload, headers = {}) {
  const contentType = normalizeString(headers["content-type"], null)?.toLowerCase() ?? null;
  const byteArray = toByteArray(payload);
  if (byteArray) {
    const bytes = new Uint8Array(byteArray);
    return {
      payload: bytes,
      bytes,
      contentType,
    };
  }
  if (
    Array.isArray(payload) &&
    payload.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255) &&
    contentType !== "application/json"
  ) {
    const bytes = Uint8Array.from(payload);
    return {
      payload: bytes,
      bytes,
      contentType,
    };
  }
  if (payload === null || payload === undefined) {
    return {
      payload: null,
      bytes: null,
      contentType,
    };
  }
  if (typeof payload === "string") {
    return {
      payload,
      bytes: textEncoder.encode(payload),
      contentType,
    };
  }
  if (typeof payload === "number" || typeof payload === "boolean") {
    const textValue = String(payload);
    return {
      payload: textValue,
      bytes: textEncoder.encode(textValue),
      contentType,
    };
  }
  const jsonPayload = JSON.stringify(payload);
  return {
    payload: jsonPayload,
    bytes: textEncoder.encode(jsonPayload),
    contentType: contentType ?? "application/json",
  };
}

function cloneHttpResponseFrame(frame = {}) {
  const payloadBytes = toByteArray(frame?.payload);
  const dataBytes = toByteArray(frame?.bytes ?? frame?.data ?? frame?.payloadBytes ?? frame?.payload_bytes);
  return {
    ...frame,
    payload: payloadBytes ? new Uint8Array(payloadBytes) : cloneJsonCompatibleValue(frame?.payload),
    bytes: dataBytes ? new Uint8Array(dataBytes) : dataBytes,
    metadata: isPlainObject(frame?.metadata) ? cloneJsonCompatibleValue(frame.metadata) : frame?.metadata ?? null,
  };
}

function normalizeExecAddPayloadPath(nodeConfig = {}) {
  if (nodeConfig?.addpay === undefined) {
    return "payload";
  }
  if (nodeConfig?.addpay === true || nodeConfig?.addpay === "true") {
    return "payload";
  }
  const explicitPath = normalizeString(nodeConfig?.addpay, null);
  return explicitPath ?? null;
}

function normalizeExecTimerMs(nodeConfig = {}) {
  const seconds = normalizeNumber(nodeConfig?.timer, 0);
  return seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function normalizeExecOldRc(nodeConfig = {}) {
  return nodeConfig?.oldrc === true || nodeConfig?.oldrc === "true";
}

function buildExecCommandString(nodeConfig = {}, inputMessage = {}) {
  let command = normalizeString(nodeConfig?.command, "") ?? "";
  const addPayloadPath = normalizeExecAddPayloadPath(nodeConfig);
  if (addPayloadPath) {
    const extraValue = getObjectPathValue(inputMessage, addPayloadPath, undefined);
    if (extraValue !== undefined) {
      command += ` ${String(extraValue)}`;
    }
  }
  const append = normalizeString(nodeConfig?.append, null);
  if (append) {
    command += ` ${append}`;
  }
  return command.trim();
}

function parseExecSpawnArguments(command) {
  return String(command ?? "")
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((entry) => (/^".*"$/.test(entry) ? entry.slice(1, -1) : entry)) ?? [];
}

function decodeExecProcessOutput(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : typeof value === "string"
      ? Buffer.from(value, "binary")
      : toByteArray(value)
        ? Buffer.from(toByteArray(value))
        : Buffer.from(String(value ?? ""), "utf8");
  if (bytes.length === 0) {
    return "";
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return Array.from(bytes);
  }
}

function createExecMessage(baseMessage, payload, extra = {}) {
  const message = cloneJsonCompatibleValue(baseMessage ?? {});
  message.payload = cloneJsonCompatibleValue(payload);
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) {
      delete message[key];
    } else {
      message[key] = cloneJsonCompatibleValue(value);
    }
  }
  return message;
}

function createExecRcPayload(nodeConfig = {}, code, signal = null, message = null) {
  if (normalizeExecOldRc(nodeConfig)) {
    return code;
  }
  const payload = { code };
  if (signal) {
    payload.signal = signal;
  }
  if (message) {
    payload.message = message;
  }
  return payload;
}

function parseInjectRepeatSeconds(node = {}) {
  const repeat = normalizeString(node?.repeat, "");
  if (!repeat) {
    return 0;
  }
  const seconds = normalizeNumber(repeat, 0);
  if (seconds <= 0 || seconds > SDN_FLOW_EDITOR_MAX_REPEAT_SECONDS) {
    return 0;
  }
  return seconds;
}

function parseInjectRepeatIntervalMs(node = {}) {
  const seconds = parseInjectRepeatSeconds(node);
  if (seconds <= 0) {
    return 0;
  }
  return Math.round(seconds * 1000);
}

function getInjectCrontabExpression(node = {}) {
  return normalizeString(node?.crontab, "");
}

function getInjectOnceDelayMs(node = {}) {
  if (!normalizeBooleanFlag(node?.once)) {
    return 0;
  }
  const seconds = normalizeNumber(
    node?.onceDelay || SDN_FLOW_EDITOR_DEFAULT_ONCE_DELAY_SECONDS,
    SDN_FLOW_EDITOR_DEFAULT_ONCE_DELAY_SECONDS,
  );
  return Math.max(0, Math.round(seconds * 1000));
}

function hasInjectTimerSchedule(node = {}) {
  return (
    getInjectOnceDelayMs(node) > 0 ||
    parseInjectRepeatIntervalMs(node) > 0 ||
    getInjectCrontabExpression(node).length > 0
  );
}

function describeInjectSchedule(node = {}) {
  const onceDelayMs = getInjectOnceDelayMs(node);
  const repeatIntervalMs = parseInjectRepeatIntervalMs(node);
  const crontab = getInjectCrontabExpression(node);
  const modes = [];
  if (onceDelayMs > 0) {
    modes.push("once");
  }
  if (repeatIntervalMs > 0) {
    modes.push("repeat");
  } else if (crontab) {
    modes.push("crontab");
  }
  return {
    nodeId: normalizeString(node?.id, null),
    name: normalizeString(node?.name, "inject"),
    once: onceDelayMs > 0,
    onceDelayMs,
    repeatIntervalMs,
    crontab,
    mode: modes.join("+") || "manual",
  };
}

function convertDelayUnitValueToMs(rawValue, rawUnits, fallbackUnits = "seconds") {
  const value = normalizeNumber(rawValue, 0);
  const units = normalizeString(rawUnits, fallbackUnits) ?? fallbackUnits;
  switch (units) {
    case "milliseconds":
      return value;
    case "minutes":
    case "minute":
      return value * 60 * 1000;
    case "hours":
    case "hour":
      return value * 60 * 60 * 1000;
    case "days":
    case "day":
      return value * 24 * 60 * 60 * 1000;
    case "seconds":
    case "second":
    default:
      return value * 1000;
  }
}

function parseDelayTimeoutMs(node = {}) {
  return Math.max(0, convertDelayUnitValueToMs(node.timeout, node.timeoutUnits, "seconds"));
}

function parseDelayRateMs(node = {}) {
  const rate = normalizeNumber(node.rate, 1);
  if (rate <= 0) {
    return 0;
  }
  const nbRateUnits = Math.max(1, Math.floor(normalizeNumber(node.nbRateUnits, 1)));
  const units = normalizeString(node.rateUnits, "second") ?? "second";
  switch (units) {
    case "minute":
      return (60 * 1000 / rate) * nbRateUnits;
    case "hour":
      return (60 * 60 * 1000 / rate) * nbRateUnits;
    case "day":
      return (24 * 60 * 60 * 1000 / rate) * nbRateUnits;
    case "second":
    default:
      return (1000 / rate) * nbRateUnits;
  }
}

function parseDelayRandomRangeMs(node = {}) {
  const firstMs = Math.max(0, convertDelayUnitValueToMs(node.randomFirst, node.randomUnits, "seconds"));
  const lastMs = Math.max(0, convertDelayUnitValueToMs(node.randomLast, node.randomUnits, "seconds"));
  return {
    firstMs,
    lastMs,
    diffMs: lastMs - firstMs,
  };
}

function parseDelayMessageRateOverrideMs(rawValue, fallback = 0) {
  const parsed = Number.parseFloat(String(rawValue ?? fallback));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSdnFlowEditorTriggerProperty(rawValue, rawType) {
  let type = normalizeString(rawType, "str") ?? "str";
  let value = rawValue;
  if (type === "date" && (value === "1" || value === "0")) {
    value = "";
  }
  if (type === "val") {
    if (value === "true" || value === "false") {
      type = "bool";
    } else if (value === "null") {
      type = "nul";
      value = null;
    } else {
      type = "str";
    }
  }
  if (type === "null") {
    type = "nul";
  }
  return {
    type,
    value,
    templated: type === "str" && String(value ?? "").includes("{{"),
  };
}

function parseTriggerDurationConfig(node = {}) {
  let duration = Number.parseFloat(String(node?.duration ?? 250));
  if (!Number.isFinite(duration)) {
    duration = 250;
  }
  let loop = false;
  if (duration < 0) {
    loop = true;
    duration *= -1;
  }
  const units = normalizeString(node?.units, "ms") ?? "ms";
  if (units === "s") {
    duration *= 1000;
  } else if (units === "min") {
    duration *= 60 * 1000;
  } else if (units === "hr") {
    duration *= 60 * 60 * 1000;
  }
  return {
    durationMs: Math.max(0, duration),
    loop,
  };
}

function getTriggerTopicKey(nodeConfig = {}, message = {}) {
  if ((normalizeString(nodeConfig?.bytopic, "all") ?? "all") === "all") {
    return "_none";
  }
  return String(
    getObjectPathValue(
      message,
      normalizeString(nodeConfig?.topic, "topic") ?? "topic",
      null,
    ) || "_none",
  );
}

function isTriggerResetMessage(nodeConfig = {}, message = {}) {
  if (Object.prototype.hasOwnProperty.call(message ?? {}, "reset")) {
    return true;
  }
  const resetValue = normalizeString(nodeConfig?.reset, "") ?? "";
  if (!resetValue) {
    return false;
  }
  const payload = message?.payload;
  return payload !== null && payload !== undefined && typeof payload?.toString === "function" && payload.toString() === resetValue;
}

function evaluateSdnFlowEditorTriggerPropertyValue(definition, message, options = {}) {
  if (!definition) {
    return SDN_FLOW_EDITOR_TRIGGER_NOTHING;
  }
  if (definition.type === "nul") {
    return SDN_FLOW_EDITOR_TRIGGER_NOTHING;
  }
  if (definition.type === "pay") {
    return cloneJsonCompatibleValue(message?.payload);
  }
  if (definition.type === "payl") {
    return cloneJsonCompatibleValue(message);
  }
  if (definition.templated) {
    return mustache.render(
      String(definition.value ?? ""),
      message && typeof message === "object" && !Array.isArray(message)
        ? message
        : { payload: message },
    );
  }
  return cloneJsonCompatibleValue(
    evaluateTypedInputValue(definition.value, definition.type, {
      env: options.env,
      msg: message,
      flow: options.flow,
      global: options.global,
    }),
  );
}

function getDelayFlushCount(rawValue, fallback) {
  if (
    typeof rawValue === "number" ||
    (typeof rawValue === "string" && rawValue.trim().length > 0)
  ) {
    const parsed = Number.parseFloat(String(rawValue));
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }
  return fallback;
}

function countMessageKeys(message) {
  return isPlainObject(message) ? Object.keys(message).length : 0;
}

function isDelayControlOnlyMessage(message, propertyName) {
  return (
    isPlainObject(message) &&
    countMessageKeys(message) === 2 &&
    Object.prototype.hasOwnProperty.call(message, propertyName)
  );
}

function stripDelayControlProperties(message) {
  const cloned = cloneJsonCompatibleValue(message);
  if (cloned && typeof cloned === "object" && !Array.isArray(cloned)) {
    delete cloned.flush;
    delete cloned.reset;
  }
  return cloned;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function getExecutableName(platform = process.platform) {
  return `sdn-flow-editor${platform === "win32" ? ".exe" : ""}`;
}

function getNodeCommand(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

function normalizePort(value, fallback = SDN_FLOW_EDITOR_DEFAULT_PORT) {
  const port = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

function normalizeBasePath(value, fallback = "/") {
  const normalized = normalizeString(value, fallback) ?? fallback;
  if (normalized === "/") {
    return "/";
  }
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function normalizeStartupSettings(value = {}, fallback = {}) {
  return {
    protocol: normalizeStartupProtocol(value.protocol, fallback.protocol ?? "http"),
    hostname:
      normalizeString(
        value.hostname,
        fallback.hostname ?? SDN_FLOW_EDITOR_DEFAULT_HOSTNAME,
      ) ?? SDN_FLOW_EDITOR_DEFAULT_HOSTNAME,
    port: normalizePort(value.port, fallback.port ?? SDN_FLOW_EDITOR_DEFAULT_PORT),
    basePath: normalizeBasePath(value.basePath, fallback.basePath ?? SDN_FLOW_EDITOR_DEFAULT_BASE_PATH),
    title:
      normalizeString(value.title, fallback.title ?? SDN_FLOW_EDITOR_DEFAULT_TITLE) ??
      SDN_FLOW_EDITOR_DEFAULT_TITLE,
  };
}

export function isLegacyDefaultSdnFlowEditorStartup(value = {}) {
  const normalized = {
    hostname:
      normalizeString(value.hostname, SDN_FLOW_EDITOR_DEFAULT_HOSTNAME) ??
      SDN_FLOW_EDITOR_DEFAULT_HOSTNAME,
    port: normalizePort(value.port, SDN_FLOW_EDITOR_LEGACY_DEFAULT_PORT),
    basePath: normalizeBasePath(value.basePath, SDN_FLOW_EDITOR_DEFAULT_BASE_PATH),
    title:
      normalizeString(value.title, SDN_FLOW_EDITOR_DEFAULT_TITLE) ??
      SDN_FLOW_EDITOR_DEFAULT_TITLE,
  };
  return (
    normalized.hostname === SDN_FLOW_EDITOR_DEFAULT_HOSTNAME &&
    normalized.port === SDN_FLOW_EDITOR_LEGACY_DEFAULT_PORT &&
    normalized.basePath === SDN_FLOW_EDITOR_DEFAULT_BASE_PATH &&
    normalized.title === SDN_FLOW_EDITOR_DEFAULT_TITLE
  );
}

export function migrateLegacyDefaultSdnFlowEditorStartup(value = {}, fallback = {}) {
  if (!isLegacyDefaultSdnFlowEditorStartup(value)) {
    return normalizeStartupSettings(value, fallback);
  }
  return normalizeStartupSettings(
    {
      ...value,
      port: SDN_FLOW_EDITOR_DEFAULT_PORT,
    },
    fallback,
  );
}

function normalizeFlowState(value, fallback = "start") {
  const normalized = normalizeString(value, fallback) ?? fallback;
  if (normalized === "stop" || normalized === "safe") {
    return normalized;
  }
  return "start";
}

function buildEditorBasePath(basePath = "/") {
  return basePath && basePath !== "/" ? `${basePath}/` : "/";
}

export function buildSdnFlowEditorUrl(startup = {}) {
  const normalized = normalizeStartupSettings(startup);
  return `${normalized.protocol}://${normalized.hostname}:${normalized.port}${
    buildEditorBasePath(normalized.basePath)
  }`;
}

function formatErrorMessage(error) {
  if (typeof error?.stack === "string" && error.stack.trim().length > 0) {
    return error.stack;
  }
  if (typeof error?.message === "string" && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function mergeImportObjects(base = {}, extra = {}) {
  const merged = { ...(base ?? {}) };
  for (const [moduleName, moduleValue] of Object.entries(extra ?? {})) {
    const existing = merged[moduleName];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      moduleValue &&
      typeof moduleValue === "object" &&
      !Array.isArray(moduleValue)
    ) {
      merged[moduleName] = {
        ...existing,
        ...moduleValue,
      };
      continue;
    }
    merged[moduleName] = moduleValue;
  }
  return merged;
}

async function instantiateArtifactWithLoaderModule(loaderModuleSource, moduleBytes, imports = {}) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sdn-flow-loader-"));
  const loaderPath = path.join(tempDirectory, "flow-loader.mjs");
  await fs.writeFile(loaderPath, String(loaderModuleSource ?? ""), "utf8");
  try {
    const importedModule = await import(`${pathToFileURL(loaderPath).href}?v=${Date.now()}`);
    const factory = importedModule?.default ?? importedModule;
    if (typeof factory !== "function") {
      throw new Error("Compiled loader module did not export a default factory.");
    }

    let wasmExports = null;
    const emscriptenModule = await factory({
      noInitialRun: true,
      wasmBinary: moduleBytes,
      print() {},
      printErr() {},
      instantiateWasm(baseImports, receiveInstance) {
        return WebAssembly.instantiate(moduleBytes, mergeImportObjects(baseImports, imports)).then(
          (instantiated) => {
            wasmExports = instantiated.instance.exports;
            receiveInstance(instantiated.instance, instantiated.module);
            return instantiated.instance.exports;
          },
        );
      },
    });

    const exports = {
      ...(wasmExports ?? {}),
      ...(emscriptenModule ?? {}),
      memory:
        wasmExports?.memory ??
        emscriptenModule?.memory ??
        emscriptenModule?.wasmMemory ??
        null,
    };
    return {
      instance: {
        exports,
      },
      exports,
    };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = (options.spawnProcess ?? childProcessSpawn)(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function launchExecutable(executablePath, args = [], options = {}) {
  const child = (options.spawnProcess ?? spawn)(executablePath, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: options.detached ?? true,
    stdio: options.stdio ?? "ignore",
  });
  if (options.unref !== false && typeof child?.unref === "function") {
    child.unref();
  }
  return child;
}

function installSignalForwarding(child) {
  const relay = (signal) => {
    if (typeof child?.kill === "function" && child.killed !== true) {
      try {
        child.kill(signal);
      } catch {
        // Ignore cases where the child has already exited.
      }
    }
  };
  process.on("SIGINT", relay);
  process.on("SIGTERM", relay);
  return () => {
    process.off("SIGINT", relay);
    process.off("SIGTERM", relay);
  };
}

async function waitForChildExit(child) {
  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
      });
    });
  });
}

async function launchForegroundReplacement(executablePath, args = [], options = {}) {
  const child = launchExecutable(executablePath, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    spawnProcess: options.spawnProcess,
    detached: false,
    stdio: options.stdio ?? "inherit",
    unref: false,
  });
  const disposeSignalHandlers = installSignalForwarding(child);
  try {
    return await waitForChildExit(child);
  } finally {
    disposeSignalHandlers();
  }
}

async function launchForegroundReplacementWithDenoCommand(
  executablePath,
  args = [],
  options = {},
) {
  const child = new globalThis.Deno.Command(executablePath, {
    args,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const relay = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // Ignore cases where the child has already exited.
    }
  };
  process.on("SIGINT", relay);
  process.on("SIGTERM", relay);
  try {
    return await child.status;
  } finally {
    process.off("SIGINT", relay);
    process.off("SIGTERM", relay);
  }
}

export function resolveSdnFlowEditorProjectRoot(options = {}) {
  const projectRoot = normalizeString(options.projectRoot, null);
  if (projectRoot) {
    return path.resolve(projectRoot);
  }
  return path.resolve(options.cwd ?? process.cwd());
}

export function getSdnFlowEditorRuntimePaths(options = {}) {
  const projectRoot = resolveSdnFlowEditorProjectRoot(options);
  const executableName = getExecutableName(options.platform);
  const generatedToolsDir = path.join(projectRoot, "generated-tools");
  const runtimeDir = path.join(generatedToolsDir, ".runtime");
  const archiveDir = path.join(generatedToolsDir, "archives");
  const artifactArchiveDir = path.join(runtimeDir, "artifacts");
  const targetExecutablePath = path.join(generatedToolsDir, executableName);
  const stagingExecutablePath = path.join(runtimeDir, "staging", executableName);
  const sessionFilePath = path.join(runtimeDir, "session.json");
  const settingsFilePath = path.join(runtimeDir, "editor-settings.json");
  const currentBuildFilePath = path.join(runtimeDir, "current-flow-build.json");
  return {
    projectRoot,
    generatedToolsDir,
    runtimeDir,
    archiveDir,
    artifactArchiveDir,
    targetExecutablePath,
    stagingExecutablePath,
    sessionFilePath,
    settingsFilePath,
    currentBuildFilePath,
    executableName,
  };
}

export async function writeSdnFlowEditorSessionFile(filePath, value) {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(value, null, 2), "utf8");
  return resolvedPath;
}

export async function readSdnFlowEditorSessionFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const text = await fs.readFile(resolvedPath, "utf8");
  return JSON.parse(text);
}

export async function writeSdnFlowEditorSettingsFile(filePath, value) {
  const resolvedPath = path.resolve(filePath);
  const payload = normalizeSdnFlowEditorSettingsRecord(value);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(payload, null, 2), "utf8");
  return resolvedPath;
}

export async function readSdnFlowEditorSettingsFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const text = await fs.readFile(resolvedPath, "utf8");
  return JSON.parse(text);
}

export async function writeSdnFlowEditorBuildFile(filePath, value) {
  const resolvedPath = path.resolve(filePath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, JSON.stringify(value, null, 2), "utf8");
  return resolvedPath;
}

export async function readSdnFlowEditorBuildFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  const text = await fs.readFile(resolvedPath, "utf8");
  return JSON.parse(text);
}

function slugifyArchiveSegment(value, fallback = "flow-artifact") {
  const slug = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function normalizeArtifactArchiveLimit(value) {
  const limit = Number.parseInt(String(value ?? SDN_FLOW_EDITOR_DEFAULT_ARTIFACT_ARCHIVE_LIMIT), 10);
  return Number.isFinite(limit) && limit >= 0
    ? limit
    : SDN_FLOW_EDITOR_DEFAULT_ARTIFACT_ARCHIVE_LIMIT;
}

function normalizeSdnFlowEditorSettingsRecord(value = {}, fallback = {}) {
  const fallbackStartup =
    fallback?.startup && typeof fallback.startup === "object"
      ? fallback.startup
      : fallback;
  const fallbackSecurity =
    fallback?.security && typeof fallback.security === "object"
      ? fallback.security
      : {};
  const startupSource =
    value?.startup && typeof value.startup === "object"
      ? value.startup
      : value;
  return {
    kind: "sdn-flow-editor-settings",
    version: 1,
    startup: normalizeStartupSettings(startupSource, fallbackStartup),
    artifactArchiveLimit: normalizeArtifactArchiveLimit(
      value?.artifactArchiveLimit ?? fallback?.artifactArchiveLimit,
    ),
    security: normalizeManagedSecuritySettings(value?.security, {
      projectRoot: resolveSdnFlowEditorProjectRoot(fallback),
      fallback: fallbackSecurity,
    }),
  };
}

async function archiveCurrentSdnFlowEditorBuild(currentBuildFilePath, artifactArchiveDir) {
  const resolvedCurrentPath = path.resolve(currentBuildFilePath);
  if (!(await pathExists(resolvedCurrentPath))) {
    return null;
  }
  const currentBuild = await readSdnFlowEditorBuildFile(resolvedCurrentPath);
  await fs.mkdir(path.resolve(artifactArchiveDir), { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archiveName = `${slugifyArchiveSegment(
    currentBuild?.artifactSummary?.programId ?? currentBuild?.serializedArtifact?.programId ?? "flow-artifact",
  )}-${timestamp}.json`;
  const archivePath = path.join(path.resolve(artifactArchiveDir), archiveName);
  await fs.rename(resolvedCurrentPath, archivePath);
  return archivePath;
}

async function trimArchivedSdnFlowEditorBuilds(artifactArchiveDir, limit) {
  const normalizedLimit = normalizeArtifactArchiveLimit(limit);
  if (normalizedLimit < 0 || !(await pathExists(artifactArchiveDir))) {
    return;
  }
  const entries = await fs.readdir(artifactArchiveDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(artifactArchiveDir, entry.name);
        const stats = await fs.stat(filePath);
        return {
          path: filePath,
          modifiedAt: stats.mtimeMs,
        };
      }),
  );
  files.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const staleFiles = files.slice(normalizedLimit);
  await Promise.all(staleFiles.map((entry) => fs.rm(entry.path, { force: true })));
}

export async function archiveSdnFlowEditorExecutable(options = {}) {
  const archiveDir = path.resolve(options.archiveDir ?? "");
  const sourcePath = normalizeString(
    options.currentExecutablePath ?? options.targetExecutablePath,
    null,
  );
  if (!archiveDir || !sourcePath) {
    return null;
  }
  const resolvedSourcePath = path.resolve(sourcePath);
  if (!(await pathExists(resolvedSourcePath))) {
    return null;
  }

  await fs.mkdir(archiveDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archiveName = `${path.basename(
    resolvedSourcePath,
    path.extname(resolvedSourcePath),
  )}-${timestamp}${path.extname(resolvedSourcePath)}`;
  const archivePath = path.join(archiveDir, archiveName);
  await fs.rename(resolvedSourcePath, archivePath);
  return archivePath;
}

export async function replaceSdnFlowEditorExecutable(options = {}) {
  const stagingExecutablePath = path.resolve(options.stagingExecutablePath ?? "");
  const targetExecutablePath = path.resolve(options.targetExecutablePath ?? "");
  if (!stagingExecutablePath || !targetExecutablePath) {
    throw new Error("Both staging and target executable paths are required.");
  }
  if (!(await pathExists(stagingExecutablePath))) {
    throw new Error(`Staging executable not found at ${stagingExecutablePath}`);
  }

  await fs.mkdir(path.dirname(targetExecutablePath), { recursive: true });
  if (await pathExists(targetExecutablePath)) {
    await fs.rm(targetExecutablePath, { force: true });
  }
  await fs.rename(stagingExecutablePath, targetExecutablePath);
  return targetExecutablePath;
}

export async function listArchivedSdnFlowEditorExecutables(options = {}) {
  const { archiveDir } = getSdnFlowEditorRuntimePaths(options);
  const exists = await pathExists(archiveDir);
  if (!exists) {
    return [];
  }

  const entries = await fs.readdir(archiveDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(archiveDir, entry.name);
        const stats = await fs.stat(filePath);
        return {
          id: entry.name,
          name: entry.name,
          path: filePath,
          size: stats.size,
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
        };
      }),
  );

  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export async function deleteArchivedSdnFlowEditorExecutable(id, options = {}) {
  const normalizedId = path.basename(normalizeString(id, ""));
  if (!normalizedId) {
    throw new Error("Archive id is required.");
  }
  const { archiveDir } = getSdnFlowEditorRuntimePaths(options);
  const targetPath = path.join(archiveDir, normalizedId);
  await fs.rm(targetPath, { force: true });
  return {
    deleted: true,
    id: normalizedId,
    path: targetPath,
  };
}

export async function listArchivedSdnFlowEditorBuilds(options = {}) {
  const { artifactArchiveDir } = getSdnFlowEditorRuntimePaths(options);
  const exists = await pathExists(artifactArchiveDir);
  if (!exists) {
    return [];
  }

  const entries = await fs.readdir(artifactArchiveDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(artifactArchiveDir, entry.name);
        const stats = await fs.stat(filePath);
        let buildRecord = null;
        try {
          buildRecord = await readSdnFlowEditorBuildFile(filePath);
        } catch {
          buildRecord = null;
        }
        const artifactSummary = buildRecord?.artifactSummary ?? {};
        const serializedArtifact = buildRecord?.serializedArtifact ?? {};
        const flowEntries = asArray(buildRecord?.flows).filter((item) => item && typeof item === "object");
        return {
          id: entry.name,
          name:
            normalizeString(artifactSummary.programId, null) ??
            normalizeString(serializedArtifact.programId, null) ??
            normalizeString(buildRecord?.outputName, null) ??
            entry.name,
          path: filePath,
          size: stats.size,
          createdAt: buildRecord?.createdAt ?? stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          compileId: buildRecord?.compileId ?? null,
          artifactId:
            normalizeString(artifactSummary.artifactId, null) ??
            normalizeString(serializedArtifact.artifactId, null),
          programId:
            normalizeString(artifactSummary.programId, null) ??
            normalizeString(serializedArtifact.programId, null),
          outputName: normalizeString(buildRecord?.outputName, null),
          runtimeModel:
            normalizeString(buildRecord?.runtimeModel, null) ??
            normalizeString(artifactSummary.runtimeModel, null),
          wasmBytes: Number(artifactSummary.wasmBytes ?? 0),
          manifestBytes: Number(artifactSummary.manifestBytes ?? 0),
          flowCount: flowEntries.length,
          warningCount: asArray(buildRecord?.warnings).length,
        };
      }),
  );

  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

export async function deleteArchivedSdnFlowEditorBuild(id, options = {}) {
  const normalizedId = path.basename(normalizeString(id, ""));
  if (!normalizedId) {
    throw new Error("Archive id is required.");
  }
  const { artifactArchiveDir } = getSdnFlowEditorRuntimePaths(options);
  const targetPath = path.join(artifactArchiveDir, normalizedId);
  await fs.rm(targetPath, { force: true });
  return {
    deleted: true,
    id: normalizedId,
    path: targetPath,
  };
}

function resolveCurrentExecutablePath(options = {}) {
  const explicitPath = normalizeString(options.currentExecutablePath, null);
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  const execPath = normalizeString(process.execPath, null);
  if (!execPath) {
    return null;
  }
  const basename = path.basename(execPath);
  if (basename.startsWith("sdn-flow-editor")) {
    return execPath;
  }
  return null;
}

function createRuntimeId() {
  return `runtime-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function createSdnFlowEditorRuntimeManager(options = {}) {
  const runtimeId = normalizeString(options.runtimeId, null) ?? createRuntimeId();
  const activeStartup = normalizeStartupSettings(options);
  let startup = { ...activeStartup };
  let flowState = normalizeFlowState(options.flowState, "start");
  const runtimePaths = getSdnFlowEditorRuntimePaths(options);
  const defaultSecuritySettings = createDefaultEditorManagedSecuritySettings({
    projectRoot: runtimePaths.projectRoot,
  });
  const activeSecuritySettings = normalizeManagedSecuritySettings(options.security, {
    projectRoot: runtimePaths.projectRoot,
    fallback: defaultSecuritySettings,
  });
  let securitySettings = cloneJsonCompatibleValue(activeSecuritySettings);
  const currentExecutablePath = resolveCurrentExecutablePath(options);
  const runBuildCommand = options.runBuildCommand ?? runCommand;
  const compileFlowArtifact =
    options.compileFlowArtifact ?? compileNodeRedFlowsToSdnArtifactInSubprocess;
  const spawnProcess = options.spawnProcess ?? childProcessSpawn;
  const execCommand = options.execCommand ?? childProcessExec;
  const spawnExecProcess = options.spawnChildProcess ?? childProcessSpawn;
  const editorExecutableScriptPath = path.join(
    runtimePaths.projectRoot,
    "scripts",
    "editor-executable.mjs",
  );
  const restartAfterCompile = options.restartAfterCompile === true;
  let artifactArchiveLimit = normalizeArtifactArchiveLimit(options.artifactArchiveLimit);
  const execProcess =
    typeof options.execProcess === "function" ? options.execProcess : null;
  const launchReplacement =
    options.launchReplacement ??
    ((launchOptions) => {
      if (globalThis.Deno?.Command) {
        return launchForegroundReplacementWithDenoCommand(
          launchOptions.executablePath,
          launchOptions.args,
          {
            cwd: launchOptions.cwd,
            env: launchOptions.env,
          },
        );
      }
      return launchForegroundReplacement(launchOptions.executablePath, launchOptions.args, {
        cwd: launchOptions.cwd,
        env: launchOptions.env,
        spawnProcess,
        stdio: launchOptions.stdio ?? "inherit",
      });
    });
  const logError = options.logError ?? console.error.bind(console);
  const delegatedRuntimeSupport = normalizeDelegatedRuntimeSupportOptions(options);
  const userRuntimeHandlers = options.runtimeHandlers ?? {};
  const userDelegatedRuntimeHandlers = delegatedRuntimeSupport.handlers;
  const dependencyInvoker = options.dependencyInvoker ?? null;
  const dependencyStreamBridge = options.dependencyStreamBridge ?? null;
  const artifactImports = options.artifactImports ?? {};
  const dependencyImports = options.dependencyImports ?? {};
  const scheduleTimeout = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const clearScheduledTimeout = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  const scheduleInterval = options.setRepeatingTimer ?? globalThis.setInterval.bind(globalThis);
  const clearScheduledInterval =
    options.clearRepeatingTimer ?? globalThis.clearInterval.bind(globalThis);
  const scheduleCronTask =
    options.scheduleCronTask ??
    ((expression, callback) => cronosjs.scheduleTask(expression, callback));
  const runtimeHandlers = new Map();
  const delegatedRuntimeHandlers = new Map();

  let compileState = null;
  let compilePromise = null;
  let lastCompileError = null;
  let lastSecurityError = null;
  let activeBuild = null;
  let activeArtifact = null;
  let activeRuntimeHost = null;
  let activeSecurityState = null;
  let securityStatus = null;
  let lastArtifactLoadError = null;
  let debugSequence = 0;
  let debugMessages = [];
  const functionNodeContext = new Map();
  const flowContext = new Map();
  const globalContext = new Map();
  const debugNodeStateOverrides = new Map();
  const activeInjectSchedules = new Map();
  const activeSortStates = new Map();
  const activeSplitStates = new Map();
  const activeCsvStates = new Map();
  const activeJoinStates = new Map();
  const activeBatchStates = new Map();
  const activeDelayStates = new Map();
  const activeTriggerStates = new Map();
  const activeLinkCallStates = new Map();
  const activeExecProcesses = new Map();
  let dispatchQueue = Promise.resolve();
  let lifecycle = {
    async closeHost() {},
    exitProcess: options.exitProcess ?? ((code) => process.exit(code)),
  };

  function summarizeSecurityState(state, fallbackSettings = securitySettings) {
    if (!state) {
      return {
        settings: cloneJsonCompatibleValue(fallbackSettings),
        storageDir: fallbackSettings?.storageDir ?? null,
        wallet: {
          enabled: false,
        },
        tls: {
          enabled: false,
        },
      };
    }
    return {
      settings: cloneJsonCompatibleValue(state.settings),
      storageDir: state.storageDir ?? null,
      wallet: cloneJsonCompatibleValue(state.wallet),
      tls: cloneJsonCompatibleValue(state.tls),
    };
  }

  async function buildManagedSecurityState(nextStartup = startup, nextSecurity = securitySettings) {
    return ensureManagedSecurityState({
      projectRoot: runtimePaths.projectRoot,
      startup: nextStartup,
      security: nextSecurity,
      fallback: defaultSecuritySettings,
      scopeId: "editor-runtime",
      scopeLabel: "sdn-flow Editor",
    });
  }

  async function refreshActiveSecurityState() {
    activeSecurityState = await buildManagedSecurityState(activeStartup, activeSecuritySettings);
    return activeSecurityState;
  }

  async function refreshPendingSecurityStatus(
    nextStartup = startup,
    nextSecurity = securitySettings,
  ) {
    securityStatus = await buildManagedSecurityState(nextStartup, nextSecurity);
    lastSecurityError = null;
    return securityStatus;
  }

  function getActiveFlowNodes() {
    return asArray(activeBuild?.flows).filter((entry) => entry && typeof entry === "object");
  }

  function getActiveFlowNode(nodeId) {
    const normalizedNodeId = normalizeString(nodeId, null);
    if (!normalizedNodeId) {
      return null;
    }
    return getActiveFlowNodes().find((entry) => normalizeString(entry.id, null) === normalizedNodeId) ?? null;
  }

  function getScheduledInjectNodes() {
    return getActiveFlowNodes().filter(
      (entry) =>
        normalizeString(entry?.type, null) === "inject" &&
        hasInjectTimerSchedule(entry) &&
        getTriggerIndexById(`trigger-${normalizeString(entry?.id, "")}`) >= 0,
    );
  }

  function getActiveHttpInNodes() {
    return getActiveFlowNodes().flatMap((entry) => {
      if (normalizeString(entry?.type, null) !== "http in") {
        return [];
      }
      const triggerId = `trigger-${normalizeString(entry?.id, "")}`;
      if (getTriggerIndexById(triggerId) < 0) {
        return [];
      }
      return [{
        nodeId: normalizeString(entry?.id, null),
        triggerId,
        method: normalizeHttpNodeMethod(entry?.method, "get"),
        routePath: normalizeHttpRoutePath(entry?.url),
        nodeConfig: entry,
      }];
    });
  }

  function getScheduledInjectStatus() {
    return Array.from(activeInjectSchedules.values()).map((record) => ({
      ...record.summary,
      active: true,
    }));
  }

  function resolveHttpTriggerRoute(request = {}) {
    const requestedTriggerId = normalizeString(request?.triggerId, null);
    const requestPath = normalizeHttpRoutePath(request?.path);
    const requestMethod = normalizeHttpRequestMethod(request?.method, "GET");
    const httpNodes = getActiveHttpInNodes();

    if (requestedTriggerId) {
      const matchedById = httpNodes.find((entry) => entry.triggerId === requestedTriggerId);
      if (!matchedById) {
        throw createSdnFlowEditorRuntimeHttpError(
          "SDN_FLOW_HTTP_TRIGGER_NOT_FOUND",
          `No HTTP trigger matches ${requestedTriggerId}.`,
          404,
        );
      }
      if (!doesHttpMethodMatch(matchedById.method, requestMethod)) {
        throw createSdnFlowEditorRuntimeHttpError(
          "SDN_FLOW_HTTP_METHOD_NOT_ALLOWED",
          `HTTP trigger "${requestedTriggerId}" does not accept ${requestMethod}.`,
          405,
        );
      }
      return {
        ...matchedById,
        params: matchHttpRoutePath(matchedById.routePath, requestPath) ?? {},
        requestPath,
        requestMethod,
      };
    }

    const directMatch = httpNodes.find((entry) =>
      doesHttpMethodMatch(entry.method, requestMethod) &&
      entry.routePath === requestPath
    );
    if (directMatch) {
      return {
        ...directMatch,
        params: {},
        requestPath,
        requestMethod,
      };
    }

    for (const entry of httpNodes) {
      if (!doesHttpMethodMatch(entry.method, requestMethod)) {
        continue;
      }
      const params = matchHttpRoutePath(entry.routePath, requestPath);
      if (params) {
        return {
          ...entry,
          params,
          requestPath,
          requestMethod,
        };
      }
    }

    throw createSdnFlowEditorRuntimeHttpError(
      "SDN_FLOW_HTTP_TRIGGER_NOT_FOUND",
      `No HTTP trigger matches ${requestMethod} ${requestPath}.`,
      404,
    );
  }

  function buildHttpRequestMessage(routeRecord, request = {}) {
    const headers = normalizeHttpHeaderRecord({}, request?.headers);
    const query = isPlainObject(request?.query) ? cloneJsonCompatibleValue(request.query) : {};
    const requestPath = normalizeHttpRoutePath(request?.path ?? routeRecord.routePath);
    const requestMethod = normalizeHttpRequestMethod(request?.method, routeRecord.requestMethod ?? "GET");
    const requestId =
      normalizeString(request?.requestId, null) ??
      normalizeString(headers["x-request-id"], null) ??
      `http:${requestMethod}:${requestPath}:${Date.now()}`;
    const payload = parseHttpRequestPayload(
      request?.body ?? request?.payload ?? null,
      routeRecord.nodeConfig,
      headers,
    );
    const requestUrl = buildHttpRequestPathWithQuery(requestPath, query);
    const metadata = isPlainObject(request?.metadata) ? cloneJsonCompatibleValue(request.metadata) : {};
    return {
      _msgid: requestId,
      payload,
      req: {
        requestId,
        method: requestMethod,
        url: requestUrl,
        originalUrl: normalizeString(metadata.originalUrl, requestUrl),
        path: requestPath,
        params: cloneJsonCompatibleValue(routeRecord.params ?? {}),
        query,
        headers,
        body: payload,
        route: {
          path: routeRecord.routePath,
          method: routeRecord.method,
        },
        ip: normalizeString(metadata.ip ?? metadata.remoteAddress ?? metadata.remote_address, null),
      },
      res: {
        headers: {},
        statusCode: 200,
      },
    };
  }

  function collectHttpResponseOutputs(drainResult = {}) {
    const outputs = [];
    for (const execution of asArray(drainResult?.executions)) {
      if (
        normalizeString(execution?.pluginId, null) !== "com.digitalarsenal.flow.http-response" ||
        normalizeString(execution?.methodId, null) !== "send"
      ) {
        continue;
      }
      for (const frame of asArray(execution?.outputs)) {
        outputs.push({
          nodeId: normalizeString(execution?.dispatchDescriptor?.nodeId, null),
          frame: cloneHttpResponseFrame(frame),
        });
      }
    }
    return outputs;
  }

  function getActiveLinkInNodes() {
    return getActiveFlowNodes().filter(
      (entry) => normalizeString(entry?.type, null) === "link in",
    );
  }

  function clearLinkCallStateRecord(record) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    if (record.timeoutHandle) {
      try {
        clearScheduledTimeout(record.timeoutHandle);
      } catch {
        // Ignore best-effort timeout cleanup failures.
      }
      record.timeoutHandle = null;
    }
    activeLinkCallStates.delete(record.eventId);
  }

  function stopLinkCallStates() {
    for (const record of activeLinkCallStates.values()) {
      clearLinkCallStateRecord(record);
    }
    activeLinkCallStates.clear();
  }

  function resolveLinkInNodeByName(targetName, callerNodeConfig = null) {
    const normalizedTargetName = normalizeString(targetName, null);
    if (!normalizedTargetName) {
      return null;
    }
    const callerWorkspaceId = normalizeString(callerNodeConfig?.z, null);
    const linkInNodes = getActiveLinkInNodes();
    const sameWorkspaceMatch = linkInNodes.filter((entry) =>
      normalizeString(entry?.name, null) === normalizedTargetName &&
      normalizeString(entry?.z, null) === callerWorkspaceId
    );
    if (sameWorkspaceMatch.length === 1) {
      return sameWorkspaceMatch[0];
    }
    const globalMatches = linkInNodes.filter((entry) =>
      normalizeString(entry?.name, null) === normalizedTargetName
    );
    return globalMatches.length === 1 ? globalMatches[0] : null;
  }

  function resolveLinkInTargetsFromIds(linkIds = []) {
    return asArray(linkIds)
      .map((linkId) => getActiveFlowNode(linkId))
      .filter((entry) => normalizeString(entry?.type, null) === "link in");
  }

  function resolveLinkCallTargets(nodeConfig, inputMessage) {
    const linkType = normalizeString(nodeConfig?.linkType, "static") ?? "static";
    if (linkType === "dynamic") {
      const dynamicTarget = normalizeString(inputMessage?.target, null);
      if (!dynamicTarget) {
        throw new Error("Dynamic link call nodes require msg.target.");
      }
      const directNode = getActiveFlowNode(dynamicTarget);
      if (normalizeString(directNode?.type, null) === "link in") {
        return [directNode];
      }
      const namedNode = resolveLinkInNodeByName(dynamicTarget, nodeConfig);
      if (namedNode) {
        return [namedNode];
      }
      throw new Error(`target link-in node '${dynamicTarget}' not found`);
    }
    const targets = resolveLinkInTargetsFromIds(nodeConfig?.links);
    if (targets.length === 0) {
      throw new Error("Link call nodes require at least one link in target.");
    }
    return targets.slice(0, 1);
  }

  function scheduleDispatchToLinkedTargets(targetNodes, message) {
    const targets = asArray(targetNodes).filter(Boolean);
    if (targets.length === 0) {
      return;
    }
    scheduleTimeout(() => {
      if (flowState !== "start") {
        return;
      }
      for (const targetNode of targets) {
        void dispatchNodeOutputToCompiledEdges(
          targetNode,
          0,
          cloneJsonCompatibleValue(message),
        ).catch((error) => {
          logError(formatErrorMessage(error));
        });
      }
    }, 0);
  }

  function clearExecProcessRecord(record, options = {}) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    if (record.timeoutHandle) {
      try {
        clearScheduledTimeout(record.timeoutHandle);
      } catch {
        // Ignore best-effort timeout cleanup failures.
      }
      record.timeoutHandle = null;
    }
    if (options.kill === true && record.child && typeof record.child.kill === "function") {
      try {
        record.child.kill(options.signal ?? "SIGTERM");
      } catch {
        // Ignore best-effort process cleanup failures.
      }
    }
    activeExecProcesses.delete(record.recordId);
  }

  function stopExecProcesses(signal = "SIGTERM") {
    for (const record of activeExecProcesses.values()) {
      clearExecProcessRecord(record, {
        kill: true,
        signal,
      });
    }
    activeExecProcesses.clear();
  }

  function registerExecProcess(nodeConfig, child, timerMs, inputMessage) {
    const record = {
      recordId: randomUUID(),
      pid: child?.pid ?? null,
      child,
      nodeId: normalizeString(nodeConfig?.id, null),
      timeoutHandle: null,
      cleared: false,
    };
    if (timerMs > 0) {
      record.timeoutHandle = scheduleTimeout(() => {
        clearExecProcessRecord(record, {
          kill: true,
          signal: "SIGTERM",
        });
        createNodeApi(nodeConfig, inputMessage).error("timeout");
      }, timerMs);
    }
    activeExecProcesses.set(record.recordId, record);
    return record;
  }

  function findExecProcessRecordByPid(pid) {
    const normalizedPid = pid === undefined || pid === null ? null : String(pid);
    if (!normalizedPid) {
      return null;
    }
    for (const record of activeExecProcesses.values()) {
      if (record.pid !== null && String(record.pid) === normalizedPid) {
        return record;
      }
    }
    return null;
  }

  function killRequestedExecProcess(inputMessage) {
    const requestedSignal =
      typeof inputMessage?.kill === "string" && inputMessage.kill.toUpperCase().startsWith("SIG")
        ? inputMessage.kill.toUpperCase()
        : "SIGTERM";
    if (inputMessage?.pid !== undefined && inputMessage?.pid !== null) {
      const record = findExecProcessRecordByPid(inputMessage.pid);
      if (record) {
        clearExecProcessRecord(record, {
          kill: true,
          signal: requestedSignal,
        });
      }
      return;
    }
    if (activeExecProcesses.size === 1) {
      const record = activeExecProcesses.values().next().value ?? null;
      if (record) {
        clearExecProcessRecord(record, {
          kill: true,
          signal: requestedSignal,
        });
      }
    }
  }

  function getProgramEdgeRoutes(nodeId, portId) {
    const normalizedNodeId = normalizeString(nodeId, null);
    const normalizedPortId = normalizeString(portId, null);
    if (!normalizedNodeId || !normalizedPortId) {
      return [];
    }
    return asArray(activeBuild?.program?.edges).flatMap((edge, edgeIndex) => (
      normalizeString(edge?.fromNodeId, null) === normalizedNodeId &&
      normalizeString(edge?.fromPortId, null) === normalizedPortId
        ? [{ edgeIndex, edge }]
        : []
    ));
  }

  async function dispatchNodeOutputToCompiledEdges(nodeConfig, portIndex, value) {
    const portId =
      normalizeNodeRedOutputPortIds(nodeConfig)[portIndex] ??
      (portIndex <= 0 ? "out" : `out-${portIndex + 1}`);
    return queueRuntimeDispatch(async () => {
      if (!activeRuntimeHost || !activeBuild?.program || flowState !== "start") {
        return {
          idle: true,
          iterations: 0,
          skipped: true,
        };
      }
      const routes = getProgramEdgeRoutes(nodeConfig?.id, portId);
      const frames = createOutputFrames(value, portId);
      if (routes.length === 0 || frames.length === 0) {
        return {
          idle: true,
          iterations: 0,
          routedOutputs: 0,
        };
      }
      for (const route of routes) {
        for (const frame of frames) {
          activeRuntimeHost.enqueueEdgeFrame(route.edgeIndex, frame);
        }
      }
      return activeRuntimeHost.drain({
        maxIterations: 1024,
        outputStreamCap: 32,
      });
    });
  }

  function splitImmediateAndDeferredNodeMessages(value) {
    const messages = normalizeOutputMessages(value);
    if (messages.length <= 1) {
      return {
        immediate: messages.length === 1 ? messages[0] : value,
        deferred: null,
      };
    }
    return {
      immediate: messages[0],
      deferred: messages.slice(1),
    };
  }

  function dispatchDeferredNodeMessages(nodeConfig, portIndex, value) {
    const deferredMessages = normalizeOutputMessages(value);
    if (deferredMessages.length === 0) {
      return;
    }
    scheduleTimeout(() => {
      if (flowState !== "start") {
        return;
      }
      void dispatchNodeOutputToCompiledEdges(nodeConfig, portIndex, deferredMessages).catch((error) => {
        logError(formatErrorMessage(error));
      });
    }, 0);
  }

  function restartDelayInterval(record, nodeConfig) {
    if (record.intervalHandle) {
      try {
        clearScheduledInterval(record.intervalHandle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
      record.intervalHandle = null;
    }
    ensureDelayInterval(record, nodeConfig);
  }

  function clearDelayStateRecord(record) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    clearDelayPendingEntries(record);
    record.buffer = [];
    if (record.intervalHandle) {
      try {
        clearScheduledInterval(record.intervalHandle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
      record.intervalHandle = null;
    }
    activeDelayStates.delete(record.nodeId);
  }

  function clearDelayPendingEntries(record) {
    for (const pending of record?.pending ?? []) {
      if (!pending?.handle) {
        continue;
      }
      try {
        clearScheduledTimeout(pending.handle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
    }
    if (record) {
      record.pending = [];
    }
  }

  function stopDelayStates() {
    for (const record of activeDelayStates.values()) {
      clearDelayStateRecord(record);
    }
    activeDelayStates.clear();
  }

  function ensureDelayState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeDelayStates.get(nodeId);
    if (record) {
      return record;
    }
    const pauseType = normalizeString(nodeConfig?.pauseType, "delay") ?? "delay";
    const randomRange = parseDelayRandomRangeMs(nodeConfig);
    record = {
      nodeId,
      pauseType,
      timeoutMs: parseDelayTimeoutMs(nodeConfig),
      randomFirstMs: randomRange.firstMs,
      randomLastMs: randomRange.lastMs,
      randomDiffMs: randomRange.diffMs,
      fixedRateMs: parseDelayRateMs(nodeConfig),
      rateMs: parseDelayRateMs(nodeConfig),
      allowrate: normalizeBooleanFlag(nodeConfig?.allowrate),
      drop: normalizeBooleanFlag(nodeConfig?.drop),
      outputs: Number.parseInt(String(nodeConfig?.outputs ?? 1), 10) || 1,
      pending: [],
      buffer: [],
      intervalHandle: null,
      lastSentAt: null,
      cleared: false,
    };
    activeDelayStates.set(nodeId, record);
    if (pauseType === "queue" || pauseType === "timed") {
      ensureDelayInterval(record, nodeConfig);
    }
    return record;
  }

  async function dispatchDelayBufferEntry(record, nodeConfig, entry, portIndex = 0) {
    if (!entry) {
      return {
        idle: true,
        iterations: 0,
      };
    }
    return dispatchNodeOutputToCompiledEdges(nodeConfig, portIndex, entry.msg ?? entry);
  }

  async function flushDelayPendingEntries(record, nodeConfig, requestedCount = null) {
    const fallbackCount = record.pending.length;
    const count = Math.min(getDelayFlushCount(requestedCount, fallbackCount), record.pending.length);
    for (let index = 0; index < count; index += 1) {
      const entry = record.pending.shift();
      if (!entry) {
        continue;
      }
      if (entry.handle) {
        try {
          clearScheduledTimeout(entry.handle);
        } catch {
          // Ignore best-effort timer cleanup failures.
        }
        entry.handle = null;
      }
      await dispatchDelayBufferEntry(record, nodeConfig, entry, 0);
    }
  }

  async function flushDelayQueuedEntries(record, nodeConfig, requestedCount = null) {
    const fallbackCount = record.buffer.length;
    const count = Math.min(getDelayFlushCount(requestedCount, fallbackCount), record.buffer.length);
    for (let index = 0; index < count; index += 1) {
      const entry = record.buffer.shift();
      if (!entry) {
        continue;
      }
      await dispatchDelayBufferEntry(record, nodeConfig, {
        msg: stripDelayControlProperties(entry.msg ?? entry),
      }, 0);
    }
  }

  function updateDelayRateFromMessage(record, nodeConfig, message) {
    if (!record.allowrate || !Object.prototype.hasOwnProperty.call(message ?? {}, "rate")) {
      return;
    }
    const nextRateMs = parseDelayMessageRateOverrideMs(message?.rate, record.rateMs);
    if (!(nextRateMs > 0) || nextRateMs === record.rateMs) {
      return;
    }
    record.rateMs = nextRateMs;
    if (
      record.pauseType === "rate" ||
      record.pauseType === "queue" ||
      record.pauseType === "timed"
    ) {
      restartDelayInterval(record, nodeConfig);
    }
  }

  function resetDelayRecord(record, nodeConfig) {
    clearDelayPendingEntries(record);
    record.buffer = [];
    record.rateMs = record.fixedRateMs;
    record.lastSentAt = null;
    if (record.pauseType === "rate") {
      if (record.intervalHandle) {
        clearScheduledInterval(record.intervalHandle);
        record.intervalHandle = null;
      }
      return;
    }
    if (record.pauseType === "queue" || record.pauseType === "timed") {
      restartDelayInterval(record, nodeConfig);
    }
  }

  function ensureDelayInterval(record, nodeConfig) {
    if (record.intervalHandle || !(record.rateMs > 0)) {
      return;
    }
    record.intervalHandle = scheduleInterval(() => {
      const run = async () => {
        if (record.cleared === true || flowState !== "start") {
          return;
        }
        if (record.pauseType === "rate") {
          if (record.buffer.length === 0) {
            if (record.intervalHandle) {
              clearScheduledInterval(record.intervalHandle);
              record.intervalHandle = null;
            }
            return;
          }
          const entry = record.buffer.shift();
          await dispatchDelayBufferEntry(record, nodeConfig, entry, 0);
          if (record.buffer.length === 0 && record.intervalHandle) {
            clearScheduledInterval(record.intervalHandle);
            record.intervalHandle = null;
          }
          return;
        }

        if (record.pauseType === "queue") {
          if (record.buffer.length > 0) {
            const entry = record.buffer.shift();
            await dispatchDelayBufferEntry(record, nodeConfig, entry, 0);
          }
          return;
        }

        if (record.pauseType === "timed" && record.buffer.length > 0) {
          const bufferedEntries = record.buffer.splice(0, record.buffer.length);
          for (const entry of bufferedEntries) {
            await dispatchDelayBufferEntry(record, nodeConfig, entry, 0);
          }
        }
      };
      void run().catch((error) => {
        logError(formatErrorMessage(error));
      });
    }, record.rateMs);
  }

  function stopSortStates() {
    activeSortStates.clear();
  }

  function stopCsvStates() {
    activeCsvStates.clear();
  }

  function stopSplitStates() {
    activeSplitStates.clear();
  }

  function ensureSortState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeSortStates.get(nodeId);
    if (record) {
      return record;
    }
    record = normalizeSdnFlowEditorSortStateRecord({
      nodeId,
      groups: new Map(),
      pendingSequence: 0,
    });
    record.nodeId = nodeId;
    activeSortStates.set(nodeId, record);
    return record;
  }

  function ensureSplitState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeSplitStates.get(nodeId);
    if (record) {
      return record;
    }
    record = {
      nodeId,
      sequenceIndex: 0,
      remainder: "",
      buffer: Buffer.alloc(0),
    };
    activeSplitStates.set(nodeId, record);
    return record;
  }

  function ensureCsvState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeCsvStates.get(nodeId);
    if (record) {
      return record;
    }
    record = {
      nodeId,
      hdrSent: false,
    };
    activeCsvStates.set(nodeId, record);
    return record;
  }

  function clearBatchStateRecord(record) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    record.countQueue = [];
    record.intervalQueue = [];
    clearSdnFlowEditorBatchConcatPending(record);
    if (record.intervalHandle) {
      try {
        clearScheduledInterval(record.intervalHandle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
      record.intervalHandle = null;
    }
    activeBatchStates.delete(record.nodeId);
  }

  function stopBatchStates() {
    for (const record of activeBatchStates.values()) {
      clearBatchStateRecord(record);
    }
    activeBatchStates.clear();
  }

  function ensureBatchState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeBatchStates.get(nodeId);
    if (record) {
      return record;
    }
    record = normalizeSdnFlowEditorBatchStateRecord({
      nodeId,
      countQueue: [],
      intervalQueue: [],
      concatPending: new Map(),
      intervalHandle: null,
      cleared: false,
    });
    record.nodeId = nodeId;
    record.cleared = false;
    activeBatchStates.set(nodeId, record);
    return record;
  }

  function clearJoinStateRecord(record) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    for (const group of record.groups.values()) {
      clearSdnFlowEditorJoinGroupTimer(group, clearScheduledTimeout);
    }
    record.groups.clear();
    activeJoinStates.delete(record.nodeId);
  }

  function stopJoinStates() {
    for (const record of activeJoinStates.values()) {
      clearJoinStateRecord(record);
    }
    activeJoinStates.clear();
  }

  function ensureJoinState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeJoinStates.get(nodeId);
    if (record) {
      return record;
    }
    record = normalizeSdnFlowEditorJoinStateRecord({
      nodeId,
      groups: new Map(),
      cleared: false,
    });
    record.nodeId = nodeId;
    record.cleared = false;
    activeJoinStates.set(nodeId, record);
    return record;
  }

  function clearTriggerTopicHandle(topicRecord) {
    if (!topicRecord) {
      return;
    }
    if (topicRecord.handleKind === "timeout" && topicRecord.handle) {
      try {
        clearScheduledTimeout(topicRecord.handle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
    } else if (topicRecord.handleKind === "interval" && topicRecord.handle) {
      try {
        clearScheduledInterval(topicRecord.handle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
    }
    topicRecord.handle = null;
    topicRecord.handleKind = null;
  }

  function deleteTriggerTopic(record, topicKey) {
    const topicRecord = record?.topics?.get(topicKey);
    if (!topicRecord) {
      return;
    }
    clearTriggerTopicHandle(topicRecord);
    record.topics.delete(topicKey);
  }

  function clearTriggerStateRecord(record) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    for (const topicKey of record.topics.keys()) {
      deleteTriggerTopic(record, topicKey);
    }
    activeTriggerStates.delete(record.nodeId);
  }

  function stopTriggerStates() {
    for (const record of activeTriggerStates.values()) {
      clearTriggerStateRecord(record);
    }
    activeTriggerStates.clear();
  }

  function ensureTriggerState(nodeConfig) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    if (!nodeId) {
      return null;
    }
    let record = activeTriggerStates.get(nodeId);
    if (record) {
      return record;
    }
    const duration = parseTriggerDurationConfig(nodeConfig);
    record = {
      nodeId,
      durationMs: duration.durationMs,
      loop: duration.loop,
      extend:
        !duration.loop &&
        (nodeConfig?.extend === true || nodeConfig?.extend === "true"),
      overrideDelay:
        nodeConfig?.overrideDelay === true || nodeConfig?.overrideDelay === "true",
      outputs: Number.parseInt(String(nodeConfig?.outputs ?? 1), 10) === 2 ? 2 : 1,
      op1: normalizeSdnFlowEditorTriggerProperty(nodeConfig?.op1 ?? "1", nodeConfig?.op1type ?? "str"),
      op2: normalizeSdnFlowEditorTriggerProperty(nodeConfig?.op2 ?? "0", nodeConfig?.op2type ?? "str"),
      topics: new Map(),
      cleared: false,
    };
    activeTriggerStates.set(nodeId, record);
    return record;
  }

  function getTriggerDelayMs(record, message) {
    if (
      record?.overrideDelay &&
      Object.prototype.hasOwnProperty.call(message ?? {}, "delay")
    ) {
      return parseDelayMessageRateOverrideMs(message?.delay, record.durationMs);
    }
    return record?.durationMs ?? 0;
  }

  function buildTriggerImmediateMessage(record, message, options = {}) {
    if (!record || record.op1.type === "nul") {
      return null;
    }
    const baseMessage = cloneJsonCompatibleValue(message);
    if (record.op1.type === "pay") {
      return baseMessage;
    }
    baseMessage.payload = evaluateSdnFlowEditorTriggerPropertyValue(record.op1, message, options);
    return baseMessage;
  }

  function buildTriggerDelayedMessage(record, topicRecord, options = {}) {
    if (!record || !topicRecord || record.op2.type === "nul") {
      return null;
    }
    if (record.op2.type === "payl") {
      return cloneJsonCompatibleValue(
        topicRecord.latestMessage ??
        topicRecord.timeoutBaseMessage ??
        topicRecord.firstMessage,
      );
    }
    const baseMessage = cloneJsonCompatibleValue(
      topicRecord.timeoutBaseMessage ??
      topicRecord.firstMessage,
    );
    const shouldReevaluate =
      topicRecord.delayEvaluationMode === "extend"
        ? record.op2.type === "flow" || record.op2.type === "global"
        : record.op2.type === "flow" || record.op2.type === "global" || record.op2.type === "date";
    const nextPayload = shouldReevaluate
      ? evaluateSdnFlowEditorTriggerPropertyValue(
        record.op2,
        topicRecord.timeoutBaseMessage ?? topicRecord.firstMessage,
        options,
      )
      : topicRecord.preparedDelayedValue;
    baseMessage.payload = cloneJsonCompatibleValue(nextPayload);
    return baseMessage;
  }

  function scheduleTriggerTimeout(record, nodeConfig, topicKey, topicRecord, delayMs, options = {}) {
    clearTriggerTopicHandle(topicRecord);
    topicRecord.handleKind = "timeout";
    topicRecord.handle = scheduleTimeout(() => {
      const run = async () => {
        if (record.cleared === true || flowState !== "start") {
          return;
        }
        const currentRecord = record.topics.get(topicKey);
        if (currentRecord !== topicRecord) {
          return;
        }
        const outputMessage = buildTriggerDelayedMessage(record, topicRecord, options);
        deleteTriggerTopic(record, topicKey);
        if (outputMessage) {
          await dispatchNodeOutputToCompiledEdges(
            nodeConfig,
            record.outputs === 2 ? 1 : 0,
            outputMessage,
          );
        }
      };
      void run().catch((error) => {
        logError(formatErrorMessage(error));
      });
    }, delayMs);
  }

  function scheduleTriggerInterval(record, nodeConfig, topicKey, topicRecord) {
    clearTriggerTopicHandle(topicRecord);
    if (!topicRecord.loopMessage) {
      return;
    }
    topicRecord.handleKind = "interval";
    topicRecord.handle = scheduleInterval(() => {
      const run = async () => {
        if (record.cleared === true || flowState !== "start") {
          return;
        }
        const currentRecord = record.topics.get(topicKey);
        if (currentRecord !== topicRecord || !topicRecord.loopMessage) {
          return;
        }
        const loopMessage = cloneJsonCompatibleValue(topicRecord.loopMessage);
        if (record.op1.type === "date") {
          loopMessage.payload = Date.now();
        }
        await dispatchNodeOutputToCompiledEdges(nodeConfig, 0, loopMessage);
      };
      void run().catch((error) => {
        logError(formatErrorMessage(error));
      });
    }, record.durationMs);
  }

  function isDebugNodeActive(nodeId) {
    const normalizedNodeId = normalizeString(nodeId, null);
    if (!normalizedNodeId) {
      return false;
    }
    if (debugNodeStateOverrides.has(normalizedNodeId)) {
      return debugNodeStateOverrides.get(normalizedNodeId) !== false;
    }
    return getActiveFlowNode(normalizedNodeId)?.active !== false;
  }

  function getTriggerIndexById(triggerId) {
    const normalizedTriggerId = normalizeString(triggerId, null);
    if (!normalizedTriggerId) {
      return -1;
    }
    return asArray(activeBuild?.program?.triggers).findIndex(
      (trigger) => normalizeString(trigger?.triggerId, null) === normalizedTriggerId,
    );
  }

  function getFunctionContextStore(nodeId) {
    const normalizedNodeId = normalizeString(nodeId, "node");
    if (!functionNodeContext.has(normalizedNodeId)) {
      functionNodeContext.set(normalizedNodeId, new Map());
    }
    return functionNodeContext.get(normalizedNodeId);
  }

  function createContextFacade(store) {
    return {
      get(key) {
        return cloneJsonCompatibleValue(store.get(String(key)));
      },
      set(key, value) {
        store.set(String(key), cloneJsonCompatibleValue(value));
      },
    };
  }

  function pushDebugMessage(message) {
    debugSequence += 1;
    const event = {
      sequence: debugSequence,
      createdAt: new Date().toISOString(),
      message: cloneJsonCompatibleValue(message),
    };
    debugMessages.push(event);
    if (debugMessages.length > SDN_FLOW_EDITOR_DEBUG_HISTORY_LIMIT) {
      debugMessages = debugMessages.slice(-SDN_FLOW_EDITOR_DEBUG_HISTORY_LIMIT);
    }
    return event;
  }

  function queueRuntimeDispatch(work) {
    const next = dispatchQueue.catch(() => undefined).then(work);
    dispatchQueue = next.catch(() => undefined);
    return next;
  }

  function clearInjectScheduleRecord(record) {
    if (!record || record.cleared === true) {
      return;
    }
    record.cleared = true;
    if (record.onceHandle) {
      try {
        clearScheduledTimeout(record.onceHandle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
      record.onceHandle = null;
    }
    if (record.repeatHandle) {
      try {
        clearScheduledInterval(record.repeatHandle);
      } catch {
        // Ignore best-effort timer cleanup failures.
      }
      record.repeatHandle = null;
    }
    if (record.cronHandle) {
      try {
        if (typeof record.cronHandle.stop === "function") {
          record.cronHandle.stop();
        } else if (typeof record.cronHandle.dispose === "function") {
          record.cronHandle.dispose();
        }
      } catch {
        // Ignore best-effort cron cleanup failures.
      }
      record.cronHandle = null;
    }
  }

  function stopInjectSchedules() {
    for (const record of activeInjectSchedules.values()) {
      clearInjectScheduleRecord(record);
    }
    activeInjectSchedules.clear();
  }

  async function runScheduledInjectDispatch(nodeId, overrideMessage = null) {
    try {
      await dispatchInjectNode(nodeId, overrideMessage);
    } catch (error) {
      lastArtifactLoadError = formatErrorMessage(error);
      logError(lastArtifactLoadError);
    }
  }

  function startRecurringInjectSchedule(record) {
    if (!record || record.cleared === true) {
      return;
    }
    if (record.repeatIntervalMs > 0) {
      record.repeatHandle = scheduleInterval(async () => {
        await runScheduledInjectDispatch(record.nodeId);
      }, record.repeatIntervalMs);
      return;
    }
    if (record.crontab) {
      record.cronHandle = scheduleCronTask(record.crontab, async () => {
        await runScheduledInjectDispatch(record.nodeId);
      });
    }
  }

  function syncInjectSchedules() {
    stopInjectSchedules();
    if (!activeRuntimeHost || !activeBuild?.program || flowState !== "start") {
      return;
    }
    for (const injectNode of getScheduledInjectNodes()) {
      try {
        const summary = describeInjectSchedule(injectNode);
        const record = {
          nodeId: summary.nodeId,
          summary,
          onceDelayMs: summary.onceDelayMs,
          repeatIntervalMs: summary.repeatIntervalMs,
          crontab: summary.crontab,
          onceHandle: null,
          repeatHandle: null,
          cronHandle: null,
          cleared: false,
        };
        activeInjectSchedules.set(record.nodeId, record);
        if (record.onceDelayMs > 0) {
          record.onceHandle = scheduleTimeout(async () => {
            if (record.cleared === true) {
              return;
            }
            await runScheduledInjectDispatch(record.nodeId);
            if (record.cleared === true) {
              return;
            }
            startRecurringInjectSchedule(record);
          }, record.onceDelayMs);
          continue;
        }
        startRecurringInjectSchedule(record);
      } catch (error) {
        activeInjectSchedules.delete(normalizeString(injectNode?.id, ""));
        const message = formatErrorMessage(error);
        lastArtifactLoadError = message;
        logError(message);
      }
    }
  }

  function createNodeApi(nodeConfig, currentMessage) {
    const nodeId = normalizeString(nodeConfig?.id, null);
    const emitLog = (level, payload) => {
      if (!isDebugNodeActive(nodeId)) {
        return;
      }
      pushDebugMessage({
        id: nodeId,
        name: normalizeString(nodeConfig?.name, "debug"),
        topic: normalizeString(currentMessage?.topic, ""),
        msg: cloneJsonCompatibleValue(payload),
        format: inferDebugFormat(payload),
        level,
        path: normalizeString(nodeConfig?.z, null),
      });
    };
    return {
      id: nodeId,
      name: normalizeString(nodeConfig?.name, ""),
      send() {},
      status() {},
      warn(message) {
        emitLog(30, message);
      },
      log(message) {
        emitLog(20, message);
      },
      error(message) {
        emitLog(50, message);
      },
    };
  }

  function normalizeNodeInvocationFrames(result, nodeConfig) {
    const outputPortIds = normalizeNodeRedOutputPortIds(nodeConfig);
    if (outputPortIds.length === 0 || result === undefined || result === null) {
      return [];
    }
    const slots =
      outputPortIds.length <= 1
        ? [result]
        : Array.isArray(result)
          ? result
          : [result];
    return outputPortIds.flatMap((portId, index) => createOutputFrames(slots[index], portId));
  }

  function installBuiltInRuntimeHandlers() {
    runtimeHandlers.set(
      "com.digitalarsenal.editor.debug:write_debug",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        if (!nodeConfig || !isDebugNodeActive(nodeConfig.id)) {
          return { outputs: [] };
        }
        const inputMessage = decodeRuntimePayload(inputs?.[0]?.bytes) ?? {};
        pushDebugMessage(createDebugEventPayload(nodeConfig, inputMessage));
        if (nodeConfig.console === true || nodeConfig.console === "true") {
          console.log(cloneJsonCompatibleValue(inputMessage));
        }
        return { outputs: [] };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.function:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const nodeApi = createNodeApi(nodeConfig, inputMessage);
        const localContext = createContextFacade(getFunctionContextStore(nodeConfig.id));
        const flowContextApi = createContextFacade(flowContext);
        const globalContextApi = createContextFacade(globalContext);
        const emittedOutputs = [];
        let completedError = null;
        const send = (value) => {
          emittedOutputs.push(...normalizeNodeInvocationFrames(value, nodeConfig));
        };
        const done = (error = null) => {
          if (error) {
            completedError = error;
          }
        };
        nodeApi.send = send;
        nodeApi.done = done;
        const handler = new AsyncFunction(
          "msg",
          "send",
          "done",
          "node",
          "context",
          "flow",
          "global",
          "env",
          String(nodeConfig.func ?? "return msg;"),
        );
        const returned = await handler(
          inputMessage,
          send,
          done,
          nodeApi,
          localContext,
          flowContextApi,
          globalContextApi,
          {
            get: (key) => process.env[String(key)] ?? "",
          },
        );
        if (completedError) {
          throw completedError;
        }
        emittedOutputs.push(...normalizeNodeInvocationFrames(returned, nodeConfig));
        return {
          outputs: emittedOutputs,
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.switch:route",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputPortIds = normalizeNodeRedOutputPortIds(nodeConfig);
        const rules = asArray(nodeConfig.rules);
        const checkAll = String(nodeConfig.checkall ?? "true") !== "false";
        const outputs = [];
        for (let index = 0; index < Math.min(rules.length, outputPortIds.length); index += 1) {
          if (
            evaluateSwitchRule(inputMessage, rules[index], {
              env: process.env,
              propertyPath: nodeConfig.property ?? "payload",
            })
          ) {
            outputs.push(...createOutputFrames(inputMessage, outputPortIds[index]));
            if (!checkAll) {
              break;
            }
          }
        }
        return { outputs };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.change:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorChangeNodeMessage(nodeConfig, inputMessage, {
          env: options.env ?? process.env,
          flow: flowContext,
          global: globalContext,
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.sort:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorSortNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          state: ensureSortState(nodeConfig),
        });
        const outputPlan = splitImmediateAndDeferredNodeMessages(outputMessage);
        if (outputPlan.deferred) {
          dispatchDeferredNodeMessages(nodeConfig, 0, outputPlan.deferred);
        }
        return {
          outputs: createOutputFrames(
            outputPlan.immediate,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.split:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorSplitNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          state: ensureSplitState(nodeConfig),
        });
        const outputPlan = splitImmediateAndDeferredNodeMessages(outputMessage);
        if (outputPlan.deferred) {
          dispatchDeferredNodeMessages(nodeConfig, 0, outputPlan.deferred);
        }
        return {
          outputs: createOutputFrames(
            outputPlan.immediate,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.csv:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorCsvNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          state: ensureCsvState(nodeConfig),
        });
        const outputPlan = splitImmediateAndDeferredNodeMessages(outputMessage);
        if (outputPlan.deferred) {
          dispatchDeferredNodeMessages(nodeConfig, 0, outputPlan.deferred);
        }
        return {
          outputs: createOutputFrames(
            outputPlan.immediate,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.batch:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorBatchNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          state: ensureBatchState(nodeConfig),
          setInterval: scheduleInterval,
          clearInterval: clearScheduledInterval,
          onFlush: async (timedMessage) => {
            if (flowState !== "start") {
              return;
            }
            await dispatchNodeOutputToCompiledEdges(nodeConfig, 0, timedMessage);
          },
          onError: (error) => {
            logError(formatErrorMessage(error));
          },
        });
        const outputPlan = splitImmediateAndDeferredNodeMessages(outputMessage);
        if (outputPlan.deferred) {
          dispatchDeferredNodeMessages(nodeConfig, 0, outputPlan.deferred);
        }
        return {
          outputs: createOutputFrames(
            outputPlan.immediate,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.file:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = await applySdnFlowEditorFileNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          env: options.env ?? process.env,
          flow: flowContext,
          global: globalContext,
          projectRoot: runtimePaths.projectRoot,
          workingDirectory: runtimePaths.projectRoot,
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.file-in:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = await applySdnFlowEditorFileInNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          env: options.env ?? process.env,
          flow: flowContext,
          global: globalContext,
          projectRoot: runtimePaths.projectRoot,
          workingDirectory: runtimePaths.projectRoot,
        });
        const outputPlan = splitImmediateAndDeferredNodeMessages(outputMessage);
        if (outputPlan.deferred) {
          dispatchDeferredNodeMessages(nodeConfig, 0, outputPlan.deferred);
        }
        return {
          outputs: createOutputFrames(
            outputPlan.immediate,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.join:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorJoinNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
          state: ensureJoinState(nodeConfig),
          setTimer: scheduleTimeout,
          clearTimer: clearScheduledTimeout,
          onFlush: async (timedOutMessage) => {
            if (flowState !== "start") {
              return;
            }
            await dispatchNodeOutputToCompiledEdges(nodeConfig, 0, timedOutMessage);
          },
          onError: (error) => {
            logError(formatErrorMessage(error));
          },
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.json:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorJsonNodeMessage(nodeConfig, inputMessage);
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.yaml:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorYamlNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.xml:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = await applySdnFlowEditorXmlNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.html:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorHtmlNodeMessage(nodeConfig, inputMessage);
        const outputPlan = splitImmediateAndDeferredNodeMessages(outputMessage);
        if (outputPlan.deferred) {
          dispatchDeferredNodeMessages(nodeConfig, 0, outputPlan.deferred);
        }
        return {
          outputs: createOutputFrames(
            outputPlan.immediate,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.template:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorTemplateNodeMessage(nodeConfig, inputMessage, {
          env: options.env ?? process.env,
          flow: flowContext,
          global: globalContext,
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.editor.range:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const outputMessage = applySdnFlowEditorRangeNodeMessage(nodeConfig, inputMessage, {
          nodeApi: createNodeApi(nodeConfig, inputMessage),
        });
        return {
          outputs: createOutputFrames(
            outputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    delegatedRuntimeHandlers.set(
      "com.digitalarsenal.editor.delay:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const record = ensureDelayState(nodeConfig);
        if (!record) {
          return { outputs: [] };
        }

        const pauseType = record.pauseType;

        if (pauseType === "delay" || pauseType === "delayv" || pauseType === "random") {
          const controlOnlyFlush = isDelayControlOnlyMessage(inputMessage, "flush");
          if (!controlOnlyFlush) {
            let waitMs = record.timeoutMs;
            if (pauseType === "delayv") {
              waitMs = parseDelayMessageRateOverrideMs(inputMessage?.delay, record.timeoutMs);
            } else if (pauseType === "random") {
              waitMs = record.randomFirstMs + (record.randomDiffMs * Math.random());
            }
            const entry = {
              msg: cloneJsonCompatibleValue(inputMessage),
              handle: null,
            };
            entry.handle = scheduleTimeout(() => {
              const run = async () => {
                if (record.cleared === true) {
                  return;
                }
                const entryIndex = record.pending.indexOf(entry);
                if (entryIndex >= 0) {
                  record.pending.splice(entryIndex, 1);
                }
                entry.handle = null;
                if (flowState !== "start") {
                  return;
                }
                await dispatchDelayBufferEntry(record, nodeConfig, entry, 0);
              };
              void run().catch((error) => {
                logError(formatErrorMessage(error));
              });
            }, Math.max(0, waitMs));
            record.pending.push(entry);
          }

          if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "reset")) {
            clearDelayPendingEntries(record);
            return { outputs: [] };
          }
          if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "flush")) {
            await flushDelayPendingEntries(record, nodeConfig, inputMessage.flush);
          }
          return { outputs: [] };
        }

        if (pauseType === "rate") {
          updateDelayRateFromMessage(record, nodeConfig, inputMessage);
          if (!record.drop) {
            const queuedMessage = stripDelayControlProperties(inputMessage);
            if (!Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "reset")) {
              if (countMessageKeys(queuedMessage) > 1) {
                if (record.intervalHandle) {
                  if (inputMessage?.toFront === true) {
                    record.buffer.unshift({ msg: queuedMessage });
                  } else {
                    record.buffer.push({ msg: queuedMessage });
                  }
                } else {
                  await dispatchNodeOutputToCompiledEdges(nodeConfig, 0, queuedMessage);
                  ensureDelayInterval(record, nodeConfig);
                }
              }
              if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "flush")) {
                if (record.buffer.length === 0) {
                  if (record.intervalHandle) {
                    clearScheduledInterval(record.intervalHandle);
                    record.intervalHandle = null;
                  }
                } else {
                  await flushDelayQueuedEntries(record, nodeConfig, inputMessage.flush);
                  restartDelayInterval(record, nodeConfig);
                }
              }
            }
            if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "reset")) {
              resetDelayRecord(record, nodeConfig);
            }
            return { outputs: [] };
          }

          if (!Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "reset")) {
            const now = Date.now();
            if (!record.lastSentAt) {
              record.lastSentAt = now;
              return {
                outputs: createOutputFrames(inputMessage, normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out"),
              };
            }
            if ((now - record.lastSentAt) > record.rateMs) {
              record.lastSentAt = now;
              return {
                outputs: createOutputFrames(inputMessage, normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out"),
              };
            }
            if (record.outputs === 2) {
              return {
                outputs: createOutputFrames(
                  inputMessage,
                  normalizeNodeRedOutputPortIds(nodeConfig)[1] ?? "out-2",
                ),
              };
            }
          }
          if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "reset")) {
            resetDelayRecord(record, nodeConfig);
          }
          return { outputs: [] };
        }

        if (pauseType === "queue" || pauseType === "timed") {
          updateDelayRateFromMessage(record, nodeConfig, inputMessage);
          ensureDelayInterval(record, nodeConfig);
          const queuedMessage = cloneJsonCompatibleValue(inputMessage);
          const topic = normalizeString(queuedMessage?.topic, null) ?? "_none_";
          queuedMessage.topic = topic;
          let replacedIndex = -1;
          for (let index = 0; index < record.buffer.length; index += 1) {
            const entryTopic = normalizeString(record.buffer[index]?.msg?.topic, null) ?? "_none_";
            if (entryTopic === topic) {
              replacedIndex = index;
              break;
            }
          }
          if (replacedIndex >= 0) {
            const replacedEntry = record.buffer[replacedIndex];
            record.buffer[replacedIndex] = { msg: queuedMessage };
            if (record.outputs === 2 && replacedEntry?.msg) {
              await dispatchNodeOutputToCompiledEdges(
                nodeConfig,
                1,
                replacedEntry.msg,
              );
            }
          } else {
            record.buffer.push({ msg: queuedMessage });
          }

          if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "flush")) {
            await flushDelayQueuedEntries(record, nodeConfig, inputMessage.flush);
          }
          if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "reset")) {
            resetDelayRecord(record, nodeConfig);
          }
          return { outputs: [] };
        }

        return {
          outputs: createOutputFrames(
            inputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    delegatedRuntimeHandlers.set(
      "com.digitalarsenal.editor.trigger:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const record = ensureTriggerState(nodeConfig);
        if (!record) {
          return { outputs: [] };
        }
        const topicKey = getTriggerTopicKey(nodeConfig, inputMessage);
        if (isTriggerResetMessage(nodeConfig, inputMessage)) {
          deleteTriggerTopic(record, topicKey);
          return { outputs: [] };
        }

        let topicRecord = record.topics.get(topicKey);
        const delayMs = getTriggerDelayMs(record, inputMessage);
        const triggerOptions = {
          env: options.env ?? process.env,
          flow: flowContext,
          global: globalContext,
        };

        if (topicRecord && !record.loop) {
          if (record.op2.type === "payl") {
            topicRecord.latestMessage = cloneJsonCompatibleValue(inputMessage);
          }
          if (record.extend && delayMs > 0) {
            topicRecord.timeoutBaseMessage = cloneJsonCompatibleValue(inputMessage);
            topicRecord.delayEvaluationMode = "extend";
            scheduleTriggerTimeout(record, nodeConfig, topicKey, topicRecord, delayMs, triggerOptions);
          }
          return { outputs: [] };
        }

        if (topicRecord) {
          deleteTriggerTopic(record, topicKey);
        }

        topicRecord = {
          firstMessage: cloneJsonCompatibleValue(inputMessage),
          latestMessage: cloneJsonCompatibleValue(inputMessage),
          timeoutBaseMessage: cloneJsonCompatibleValue(inputMessage),
          preparedDelayedValue: undefined,
          delayEvaluationMode: "initial",
          loopMessage: null,
          handle: null,
          handleKind: null,
        };

        if (!record.loop && record.op2.type !== "nul" && record.op2.type !== "payl") {
          topicRecord.preparedDelayedValue = evaluateSdnFlowEditorTriggerPropertyValue(
            record.op2,
            inputMessage,
            triggerOptions,
          );
        }

        record.topics.set(topicKey, topicRecord);

        const immediateMessage = buildTriggerImmediateMessage(record, inputMessage, triggerOptions);
        if (delayMs === 0) {
          topicRecord.handle = 0;
          topicRecord.handleKind = "block";
        } else if (record.loop) {
          if (immediateMessage) {
            topicRecord.loopMessage = cloneJsonCompatibleValue(immediateMessage);
            scheduleTriggerInterval(record, nodeConfig, topicKey, topicRecord);
          }
        } else {
          scheduleTriggerTimeout(record, nodeConfig, topicKey, topicRecord, delayMs, triggerOptions);
        }

        if (!immediateMessage) {
          return { outputs: [] };
        }
        return {
          outputs: createOutputFrames(
            immediateMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    delegatedRuntimeHandlers.set(
      "com.digitalarsenal.editor.link-in:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        return {
          outputs: createOutputFrames(
            inputMessage,
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "out",
          ),
        };
      },
    );
    delegatedRuntimeHandlers.set(
      "com.digitalarsenal.editor.link-out:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }
        const mode = normalizeString(nodeConfig?.mode, "link") ?? "link";
        if (mode === "return") {
          const linkSource = Array.isArray(inputMessage?._linkSource)
            ? [...inputMessage._linkSource]
            : [];
          if (linkSource.length === 0) {
            createNodeApi(nodeConfig, inputMessage).warn("missing return");
            return { outputs: [] };
          }
          const messageEvent = linkSource.pop();
          const eventId = normalizeString(messageEvent?.id, null);
          const returnRecord = eventId ? activeLinkCallStates.get(eventId) : null;
          if (!returnRecord) {
            createNodeApi(nodeConfig, inputMessage).warn("missing return");
            return { outputs: [] };
          }
          clearLinkCallStateRecord(returnRecord);
          const returnMessage = cloneJsonCompatibleValue(inputMessage);
          if (linkSource.length === 0) {
            delete returnMessage._linkSource;
          } else {
            returnMessage._linkSource = linkSource;
          }
          const callerNode = getActiveFlowNode(returnRecord.callerNodeId);
          if (callerNode) {
            dispatchDeferredNodeMessages(callerNode, 0, returnMessage);
          }
          return { outputs: [] };
        }

        const targets = resolveLinkInTargetsFromIds(nodeConfig?.links);
        scheduleDispatchToLinkedTargets(targets, inputMessage);
        return { outputs: [] };
      },
    );
    delegatedRuntimeHandlers.set(
      "com.digitalarsenal.editor.link-call:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }

        let targets;
        try {
          targets = resolveLinkCallTargets(nodeConfig, inputMessage);
        } catch (error) {
          createNodeApi(nodeConfig, inputMessage).error(error.message);
          return { outputs: [] };
        }

        const messageEvent = {
          id: randomUUID().replace(/-/g, ""),
          node: normalizeString(nodeConfig?.id, null),
        };
        const forwardedMessage = cloneJsonCompatibleValue(inputMessage);
        const linkSource = Array.isArray(forwardedMessage?._linkSource)
          ? [...forwardedMessage._linkSource]
          : [];
        linkSource.push(messageEvent);
        forwardedMessage._linkSource = linkSource;

        const timeoutSeconds = normalizeNumber(nodeConfig?.timeout, 30);
        const timeoutMs = timeoutSeconds > 0 ? Math.round(timeoutSeconds * 1000) : 0;
        const record = {
          eventId: messageEvent.id,
          callerNodeId: normalizeString(nodeConfig?.id, null),
          timeoutHandle: null,
          cleared: false,
        };
        if (timeoutMs > 0) {
          record.timeoutHandle = scheduleTimeout(() => {
            clearLinkCallStateRecord(record);
            createNodeApi(nodeConfig, inputMessage).error("timeout");
          }, timeoutMs);
        }
        activeLinkCallStates.set(record.eventId, record);
        scheduleDispatchToLinkedTargets(targets, forwardedMessage);
        return { outputs: [] };
      },
    );
    delegatedRuntimeHandlers.set(
      "com.digitalarsenal.editor.exec:invoke",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        if (!nodeConfig) {
          return { outputs: [] };
        }

        if (Object.prototype.hasOwnProperty.call(inputMessage ?? {}, "kill")) {
          killRequestedExecProcess(inputMessage);
          return { outputs: [] };
        }

        const command = buildExecCommandString(nodeConfig, inputMessage);
        if (!command) {
          createNodeApi(nodeConfig, inputMessage).error("exec node requires a command");
          return { outputs: [] };
        }

        const outputPortIds = normalizeNodeRedOutputPortIds(nodeConfig);
        const timeoutMs = normalizeExecTimerMs(nodeConfig);
        const baseExecMessage = cloneJsonCompatibleValue(inputMessage);
        const windowsHide = nodeConfig?.winHide === true || nodeConfig?.winHide === "true";

        if (nodeConfig?.useSpawn === true || nodeConfig?.useSpawn === "true") {
          const argv = parseExecSpawnArguments(command);
          const executable = argv.shift();
          if (!executable) {
            createNodeApi(nodeConfig, inputMessage).error("exec node requires a command");
            return { outputs: [] };
          }
          const spawnOptions =
            process.platform === "win32"
              ? {
                  windowsHide,
                  shell: true,
                }
              : {
                  windowsHide,
                };
          const child = spawnOptions.shell
            ? spawnExecProcess([executable, ...argv].join(" "), spawnOptions)
            : spawnExecProcess(executable, argv, spawnOptions);
          const record = registerExecProcess(nodeConfig, child, timeoutMs, inputMessage);

          child.stdout?.on("data", (chunk) => {
            dispatchDeferredNodeMessages(
              nodeConfig,
              0,
              createExecMessage(baseExecMessage, decodeExecProcessOutput(chunk)),
            );
          });
          child.stderr?.on("data", (chunk) => {
            dispatchDeferredNodeMessages(
              nodeConfig,
              1,
              createExecMessage(baseExecMessage, decodeExecProcessOutput(chunk)),
            );
          });
          child.once("close", (code, signal) => {
            clearExecProcessRecord(record);
            dispatchDeferredNodeMessages(
              nodeConfig,
              2,
              createExecMessage(
                baseExecMessage,
                createExecRcPayload(nodeConfig, code, signal ?? null),
              ),
            );
          });
          child.once("error", (error) => {
            clearExecProcessRecord(record);
            createNodeApi(nodeConfig, inputMessage).error(error.message);
            dispatchDeferredNodeMessages(
              nodeConfig,
              2,
              createExecMessage(
                baseExecMessage,
                createExecRcPayload(nodeConfig, error.code ?? null, null, error.message),
              ),
            );
          });

          return { outputs: [] };
        }

        const execOptions = {
          encoding: "binary",
          maxBuffer: SDN_FLOW_EDITOR_DEFAULT_EXEC_MAX_BUFFER_BYTES,
          windowsHide,
        };

        return await new Promise((resolve) => {
          let record = null;
          const child = execCommand(command, execOptions, (error, stdout, stderr) => {
            if (record) {
              clearExecProcessRecord(record);
            }
            const stdoutMessage = createExecMessage(
              baseExecMessage,
              decodeExecProcessOutput(stdout),
            );
            const stderrMessage = stderr
              ? createExecMessage(
                  baseExecMessage,
                  decodeExecProcessOutput(stderr),
                )
              : null;
            const rcPayload = error
              ? createExecRcPayload(
                  nodeConfig,
                  error.code ?? null,
                  error.signal ?? null,
                  error.message ?? null,
                )
              : createExecRcPayload(nodeConfig, 0);
            if (rcPayload !== undefined && rcPayload !== null) {
              stdoutMessage.rc = cloneJsonCompatibleValue(rcPayload);
              if (stderrMessage) {
                stderrMessage.rc = cloneJsonCompatibleValue(rcPayload);
              }
            }
            const outputs = [
              ...createOutputFrames(stdoutMessage, outputPortIds[0] ?? "out"),
              ...(stderrMessage
                ? createOutputFrames(stderrMessage, outputPortIds[1] ?? "out-2")
                : []),
              ...(rcPayload !== undefined && rcPayload !== null
                ? createOutputFrames(
                    createExecMessage(baseExecMessage, rcPayload),
                    outputPortIds[2] ?? "out-3",
                  )
                : []),
            ];
            resolve({ outputs });
          });

          record = registerExecProcess(nodeConfig, child, timeoutMs, inputMessage);
          child.once("error", () => {
            // The exec callback handles rc output/error propagation.
          });
        });
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.flow.http-fetcher:fetch",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        const requestUrl =
          normalizeString(inputMessage?.url, null) ??
          normalizeString(nodeConfig?.url, null);
        if (!requestUrl) {
          throw new Error("HTTP request nodes require a URL.");
        }
        const configuredMethod = normalizeString(nodeConfig?.method, "GET") ?? "GET";
        const method = normalizeHttpRequestMethod(
          configuredMethod === "use"
            ? inputMessage?.method ?? inputMessage?.req?.method ?? "GET"
            : configuredMethod,
          "GET",
        );
        const configuredHeaders = normalizeConfiguredHttpHeaders(nodeConfig?.headers, inputMessage);
        const messageHeaders = normalizeHttpHeaderRecord({}, inputMessage?.headers);
        const requestHeaders = {
          ...configuredHeaders,
          ...messageHeaders,
        };
        const requestTarget = new URL(requestUrl);
        const queryMode =
          normalizeString(nodeConfig?.paytoqs, "ignore") === "true"
            ? "query"
            : normalizeString(nodeConfig?.paytoqs, "ignore") ?? "ignore";
        if (queryMode === "query" && inputMessage?.payload !== undefined && inputMessage?.payload !== null) {
          if (typeof inputMessage.payload === "string") {
            for (const [key, value] of new URLSearchParams(inputMessage.payload).entries()) {
              requestTarget.searchParams.append(key, value);
            }
          } else if (Array.isArray(inputMessage.payload)) {
            inputMessage.payload.forEach((value, index) => {
              requestTarget.searchParams.append(String(index), String(value));
            });
          } else if (isPlainObject(inputMessage.payload)) {
            for (const [key, value] of Object.entries(inputMessage.payload)) {
              if (Array.isArray(value)) {
                value.forEach((entry) => requestTarget.searchParams.append(key, String(entry)));
                continue;
              }
              if (value !== undefined && value !== null) {
                requestTarget.searchParams.set(key, String(value));
              }
            }
          }
        }
        const requestInit = {
          method,
          headers: Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined,
        };
        if (
          inputMessage?.payload !== undefined &&
          method !== "GET" &&
          method !== "HEAD" &&
          queryMode !== "query"
        ) {
          const bodyPayload = inputMessage.payload;
          if (typeof bodyPayload === "string") {
            requestInit.body = bodyPayload;
          } else {
            const bytePayload = toByteArray(bodyPayload);
            if (bytePayload) {
              requestInit.body = bytePayload;
            } else if (
              Array.isArray(bodyPayload) &&
              bodyPayload.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)
            ) {
              requestInit.body = Uint8Array.from(bodyPayload);
            } else {
              if (!requestHeaders["content-type"]) {
                requestHeaders["content-type"] = "application/json";
                requestInit.headers = requestHeaders;
              }
              requestInit.body = JSON.stringify(bodyPayload);
            }
          }
        }
        const response = await fetch(requestTarget, requestInit);
        if (normalizeBooleanFlag(nodeConfig?.senderr) && response.status >= 400) {
          throw new Error(`HTTP request failed with status ${response.status}.`);
        }
        const responsePayload =
          nodeConfig?.ret === "bin"
            ? Array.from(new Uint8Array(await response.arrayBuffer()))
            : nodeConfig?.ret === "obj"
              ? await response.json()
              : await response.text();
        return {
          outputs: createOutputFrames(
            {
              ...inputMessage,
              payload: responsePayload,
              statusCode: response.status,
              headers: Object.fromEntries(response.headers.entries()),
              responseUrl: response.url,
            },
            normalizeNodeRedOutputPortIds(nodeConfig)[0] ?? "response",
          ),
        };
      },
    );
    runtimeHandlers.set(
      "com.digitalarsenal.flow.http-response:send",
      async ({ dispatchDescriptor, inputs }) => {
        const nodeConfig = getActiveFlowNode(dispatchDescriptor?.nodeId);
        const inputMessage = cloneJsonCompatibleValue(decodeRuntimePayload(inputs?.[0]?.bytes) ?? {});
        const responseHeaders = {
          ...normalizeConfiguredHttpHeaders(nodeConfig?.headers, inputMessage),
          ...normalizeConfiguredHttpHeaders(inputMessage?.res?.headers, inputMessage),
          ...normalizeHttpHeaderRecord({}, inputMessage?.headers),
        };
        const responseStatus = normalizeHttpResponseStatusCode(
          inputMessage?.statusCode,
          inputMessage?.res?.statusCode,
          nodeConfig?.statusCode,
        );
        const responsePayload = normalizeHttpResponsePayloadData(
          inputMessage?.payload,
          responseHeaders,
        );
        if (responsePayload.contentType && !responseHeaders["content-type"]) {
          responseHeaders["content-type"] = responsePayload.contentType;
        }
        return {
          outputs: [{
            portId: "response",
            payload: responsePayload.payload,
            bytes: responsePayload.bytes,
            metadata: {
              statusCode: responseStatus,
              responseHeaders,
              contentType: responseHeaders["content-type"] ?? null,
              requestId: normalizeString(inputMessage?.req?.requestId ?? inputMessage?._msgid, null),
            },
          }],
        };
      },
    );
  }

  function applyRuntimeHandlerOverrides(overrides) {
    if (overrides instanceof Map) {
      for (const [key, handler] of overrides.entries()) {
        const definition = resolveSdnFlowEditorDelegatedRuntimeFamily({ handlerKey: key });
        (definition ? delegatedRuntimeHandlers : runtimeHandlers).set(key, handler);
      }
      return;
    }
    for (const [key, handler] of Object.entries(overrides ?? {})) {
      const definition = resolveSdnFlowEditorDelegatedRuntimeFamily({ handlerKey: key });
      (definition ? delegatedRuntimeHandlers : runtimeHandlers).set(key, handler);
    }
  }

  function createUnavailableDelegatedRuntimeHandler(definition) {
    return async ({ dispatchDescriptor }) => {
      throw createSdnFlowEditorDelegatedRuntimeUnavailableError(definition, {
        nodeId: normalizeString(dispatchDescriptor?.nodeId, null),
      });
    };
  }

  function buildBoundRuntimeHandlers() {
    const handlers = new Map(runtimeHandlers);
    for (const definition of listSdnFlowEditorDelegatedRuntimeFamilies()) {
      const supportedHandler =
        delegatedRuntimeSupport.enabled !== false
          ? delegatedRuntimeHandlers.get(definition.handlerKey)
          : null;
      handlers.set(
        definition.handlerKey,
        typeof supportedHandler === "function"
          ? supportedHandler
          : createUnavailableDelegatedRuntimeHandler(definition),
      );
    }
    return handlers;
  }

  function assertDelegatedRuntimeSupportAvailable(buildRecord = null) {
    if (delegatedRuntimeSupport.enabled !== false) {
      return;
    }
    const flows = asArray(buildRecord?.flows).filter(isPlainObject);
    const workspaceIds = new Set(
      flows
        .filter((entry) => isNodeRedTabNode(entry))
        .map((entry) => normalizeString(entry?.id, null))
        .filter(Boolean),
    );
    for (const node of flows) {
      if (isNodeRedTabNode(node) || isNodeRedSubflowDefinition(node)) {
        continue;
      }
      if (isNodeRedConfigNode(node, workspaceIds)) {
        continue;
      }
      const definition = resolveSdnFlowEditorDelegatedRuntimeFamily({
        family: normalizeString(node?.type, null),
      });
      if (!definition) {
        continue;
      }
      throw createSdnFlowEditorDelegatedRuntimeUnavailableError(definition, {
        nodeId: normalizeString(node?.id, null),
      });
    }
  }

  installBuiltInRuntimeHandlers();
  applyRuntimeHandlerOverrides(userRuntimeHandlers);
  applyRuntimeHandlerOverrides(userDelegatedRuntimeHandlers);

  const loadCompiledRuntimeHost =
    options.loadCompiledRuntimeHost ??
    (async (buildRecord) => {
      const artifact = await deserializeCompiledArtifact(buildRecord.serializedArtifact);
      const instantiateArtifact =
        typeof buildRecord?.loaderModule === "string" && buildRecord.loaderModule.length > 0
          ? (moduleBytes, imports) =>
              instantiateArtifactWithLoaderModule(buildRecord.loaderModule, moduleBytes, imports)
          : WebAssembly.instantiate;
      const host = await bindCompiledFlowRuntimeHost({
        artifact,
        handlers: buildBoundRuntimeHandlers(),
        dependencyInvoker,
        dependencyStreamBridge,
        artifactImports,
        dependencyImports,
        instantiateArtifact,
      });
      return {
        artifact,
        host,
      };
    });

  async function disposeRuntimeHost(host = null) {
    stopInjectSchedules();
    stopSortStates();
    stopSplitStates();
    stopCsvStates();
    stopJoinStates();
    stopBatchStates();
    stopDelayStates();
    stopTriggerStates();
    stopLinkCallStates();
    stopExecProcesses();
    if (!host) {
      return;
    }
    try {
      if (typeof host.resetRuntimeState === "function") {
        host.resetRuntimeState();
      }
    } catch {
      // Ignore best-effort cleanup errors during runtime replacement.
    }
    try {
      if (typeof host.destroyDependencies === "function") {
        await host.destroyDependencies();
      }
    } catch {
      // Ignore best-effort dependency cleanup failures.
    }
  }

  async function activateCompiledBuild(buildRecord) {
    assertDelegatedRuntimeSupportAvailable(buildRecord);
    const loadedRuntime = await loadCompiledRuntimeHost(buildRecord);
    const previousHost = activeRuntimeHost;
    stopInjectSchedules();
    stopSortStates();
    stopSplitStates();
    stopCsvStates();
    stopJoinStates();
    stopBatchStates();
    stopDelayStates();
    stopTriggerStates();
    stopLinkCallStates();
    stopExecProcesses();
    activeBuild = structuredClone(buildRecord);
    activeArtifact = loadedRuntime.artifact;
    activeRuntimeHost = loadedRuntime.host;
    lastArtifactLoadError = null;
    debugMessages = [];
    functionNodeContext.clear();
    flowContext.clear();
    globalContext.clear();
    debugNodeStateOverrides.clear();
    await disposeRuntimeHost(previousHost);
    syncInjectSchedules();
    return activeBuild;
  }

  async function loadPersistedCompiledBuild() {
    if (!(await pathExists(runtimePaths.currentBuildFilePath))) {
      return null;
    }
    const buildRecord = await readSdnFlowEditorBuildFile(runtimePaths.currentBuildFilePath);
    return activateCompiledBuild(buildRecord);
  }

  async function loadPersistedEditorSettings() {
    if (!(await pathExists(runtimePaths.settingsFilePath))) {
      return null;
    }
    const persistedSettings = normalizeSdnFlowEditorSettingsRecord(
      await readSdnFlowEditorSettingsFile(runtimePaths.settingsFilePath),
      {
        startup,
        artifactArchiveLimit,
        security: securitySettings,
        projectRoot: runtimePaths.projectRoot,
      },
    );
    artifactArchiveLimit = persistedSettings.artifactArchiveLimit;
    securitySettings = cloneJsonCompatibleValue(persistedSettings.security);
    return {
      ...persistedSettings,
      startup: { ...startup },
      security: cloneJsonCompatibleValue(securitySettings),
    };
  }

  async function persistCompiledBuild(buildRecord) {
    await archiveCurrentSdnFlowEditorBuild(
      runtimePaths.currentBuildFilePath,
      runtimePaths.artifactArchiveDir,
    );
    await writeSdnFlowEditorBuildFile(runtimePaths.currentBuildFilePath, buildRecord);
    await trimArchivedSdnFlowEditorBuilds(
      runtimePaths.artifactArchiveDir,
      artifactArchiveLimit,
    );
  }

  async function buildStagedExecutable() {
    await fs.mkdir(path.dirname(runtimePaths.stagingExecutablePath), {
      recursive: true,
    });
    if (await pathExists(runtimePaths.stagingExecutablePath)) {
      await fs.rm(runtimePaths.stagingExecutablePath, { force: true });
    }
    await runBuildCommand(
      getNodeCommand(options.platform),
      [
        editorExecutableScriptPath,
        "build",
        "--output",
        runtimePaths.stagingExecutablePath,
      ],
      {
        cwd: runtimePaths.projectRoot,
        env: options.env ?? process.env,
        stdio: options.buildStdio ?? "inherit",
      },
    );
  }

  async function applyStagedExecutable() {
    await archiveSdnFlowEditorExecutable({
      currentExecutablePath,
      targetExecutablePath: runtimePaths.targetExecutablePath,
      archiveDir: runtimePaths.archiveDir,
    });
    await replaceSdnFlowEditorExecutable({
      stagingExecutablePath: runtimePaths.stagingExecutablePath,
      targetExecutablePath: runtimePaths.targetExecutablePath,
    });
  }

  async function restartWithStagedExecutable() {
    if (typeof lifecycle.closeHost !== "function") {
      throw new Error("Editor runtime restart lifecycle is not bound.");
    }

    await lifecycle.closeHost();
    await archiveSdnFlowEditorExecutable({
      currentExecutablePath,
      targetExecutablePath: runtimePaths.targetExecutablePath,
      archiveDir: runtimePaths.archiveDir,
    });
    await replaceSdnFlowEditorExecutable({
      stagingExecutablePath: runtimePaths.stagingExecutablePath,
      targetExecutablePath: runtimePaths.targetExecutablePath,
    });
    compileState = null;
    const replacementArgs = [
      runtimePaths.targetExecutablePath,
      "--session-file",
      runtimePaths.sessionFilePath,
    ];
    if (execProcess) {
      execProcess(
        runtimePaths.targetExecutablePath,
        replacementArgs,
        options.env ?? process.env,
      );
      return;
    }
    const exit = await launchReplacement({
      executablePath: runtimePaths.targetExecutablePath,
      args: replacementArgs.slice(1),
      cwd: runtimePaths.projectRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    lifecycle.exitProcess(exit?.code ?? 0);
  }

  async function runCompileLifecycle(flows, compileId) {
    try {
      const compiledBuild = await compileFlowArtifact(flows, {
        cwd: runtimePaths.projectRoot,
        env: options.env ?? process.env,
      });
      const buildRecord = {
        kind: "sdn-flow-editor-flow-build",
        version: 1,
        compileId,
        createdAt: new Date().toISOString(),
        flows,
        artifactSummary: compiledBuild.artifactSummary ?? null,
        serializedArtifact: compiledBuild.serializedArtifact,
        loaderModule: compiledBuild.loaderModule ?? null,
        source: compiledBuild.source ?? "",
        outputName: compiledBuild.outputName ?? "sdn-flow-flow-runtime",
        runtimeModel: compiledBuild.runtimeModel ?? "compiled-cpp-wasm",
        sourceGeneratorModel: compiledBuild.sourceGeneratorModel ?? null,
        program: compiledBuild.program ?? null,
        warnings: Array.isArray(compiledBuild.warnings) ? compiledBuild.warnings : [],
      };
      await persistCompiledBuild(buildRecord);
      await activateCompiledBuild(buildRecord);
      await buildStagedExecutable();
      compileState = null;
      if (restartAfterCompile) {
        await restartWithStagedExecutable();
      } else {
        await applyStagedExecutable();
      }
    } catch (error) {
      compileState = null;
      lastCompileError = formatErrorMessage(error);
      lastArtifactLoadError = lastCompileError;
      logError(lastCompileError);
    } finally {
      compilePromise = null;
    }
  }

  async function dispatchInjectNode(nodeId, overrideMessage = null) {
    return queueRuntimeDispatch(async () => {
      if (!activeRuntimeHost || !activeBuild?.program) {
        throw new Error("No compiled flow runtime is loaded. Compile the flow first.");
      }
      const injectNode = getActiveFlowNode(nodeId);
      if (!injectNode || normalizeString(injectNode.type, null) !== "inject") {
        throw new Error(`Inject node "${nodeId}" is not available in the compiled runtime.`);
      }
      const triggerId = `trigger-${injectNode.id}`;
      const triggerIndex = getTriggerIndexById(triggerId);
      if (triggerIndex < 0) {
        throw new Error(`Compiled flow runtime has no trigger binding for inject node "${nodeId}".`);
      }
      activeRuntimeHost.enqueueTriggerFrame(triggerIndex, {
        typeRef: SDN_FLOW_EDITOR_RUNTIME_MESSAGE_TYPE,
        bytes: encodeRuntimePayload(
          buildInjectMessage(injectNode, {
            env: options.env ?? process.env,
          }, overrideMessage),
        ),
      });
      return activeRuntimeHost.drain({
        maxIterations: 1024,
        outputStreamCap: 32,
      });
    });
  }

  function setDebugNodeState(nodeIds, active) {
    const updatedIds = [];
    for (const candidate of asArray(nodeIds)) {
      const nodeId = normalizeString(candidate, null);
      if (!nodeId) {
        continue;
      }
      debugNodeStateOverrides.set(nodeId, active !== false);
      updatedIds.push(nodeId);
    }
    return {
      ok: true,
      active: active !== false,
      nodes: updatedIds,
    };
  }

  function resolveRuntimePathClassification(nodeId, family, pluginId, methodId) {
    const delegatedDefinition = resolveSdnFlowEditorDelegatedRuntimeFamily({
      family,
      pluginId,
      methodId,
    });
    if (delegatedDefinition) {
      return {
        classification: SDN_FLOW_EDITOR_RUNTIME_CLASSIFICATION.DELEGATED,
        handlerKey: delegatedDefinition.handlerKey,
      };
    }
    for (const key of createRuntimeHandlerLookupKeys({
      nodeId,
      pluginId,
      methodId,
    })) {
      if (runtimeHandlers.has(key)) {
        return {
          classification: SDN_FLOW_EDITOR_RUNTIME_CLASSIFICATION.JS_SHIM,
          handlerKey: key,
        };
      }
    }
    if (
      typeof dependencyInvoker === "function" ||
      typeof dependencyStreamBridge === "function"
    ) {
      return {
        classification: SDN_FLOW_EDITOR_RUNTIME_CLASSIFICATION.DELEGATED,
        handlerKey:
          (pluginId && methodId && `${pluginId}:${methodId}`) ||
          pluginId ||
          methodId ||
          nodeId ||
          null,
      };
    }
    return {
      classification: SDN_FLOW_EDITOR_RUNTIME_CLASSIFICATION.COMPILED,
      handlerKey:
        (pluginId && methodId && `${pluginId}:${methodId}`) ||
        pluginId ||
        methodId ||
        nodeId ||
        null,
    };
  }

  function buildRuntimeClassificationStatus() {
    const classificationStatus = createEmptyRuntimeClassificationStatus();
    const flows = asArray(activeBuild?.flows).filter(isPlainObject);
    if (flows.length === 0) {
      return classificationStatus;
    }

    const workspaceIds = new Set(
      flows
        .filter((entry) => isNodeRedTabNode(entry))
        .map((entry) => normalizeString(entry?.id, null))
        .filter(Boolean),
    );
    const programNodesById = new Map();
    for (const entry of asArray(activeBuild?.program?.nodes)) {
      const nodeId = normalizeString(entry?.nodeId, null);
      if (nodeId) {
        programNodesById.set(nodeId, entry);
      }
    }

    const familyEntries = new Map();
    const handlerEntries = new Map();
    const classificationCounts = {
      compiled: 0,
      delegated: 0,
      "js-shim": 0,
    };
    let totalNodes = 0;

    const getFamilyEntry = (family, classification) => {
      const entryKey = `${family}\u0000${classification}`;
      if (!familyEntries.has(entryKey)) {
        familyEntries.set(entryKey, {
          family,
          classification,
          count: 0,
          nodeIds: new Set(),
          triggerIds: new Set(),
          pluginIds: new Set(),
          methodIds: new Set(),
          handlerKeys: new Set(),
        });
      }
      return familyEntries.get(entryKey);
    };

    const getHandlerEntry = (handlerKey, classification) => {
      const entryKey = `${handlerKey ?? "unresolved"}\u0000${classification}`;
      if (!handlerEntries.has(entryKey)) {
        handlerEntries.set(entryKey, {
          key: handlerKey,
          classification,
          count: 0,
          nodeIds: new Set(),
          families: new Set(),
          pluginIds: new Set(),
          methodIds: new Set(),
        });
      }
      return handlerEntries.get(entryKey);
    };

    for (const node of flows) {
      if (isNodeRedTabNode(node) || isNodeRedSubflowDefinition(node)) {
        continue;
      }
      if (isNodeRedConfigNode(node, workspaceIds)) {
        continue;
      }

      const nodeId = normalizeString(node?.id, null);
      const family = normalizeString(node?.type, "unknown") ?? "unknown";
      if (!nodeId) {
        continue;
      }

      if (family === "inject" || family === "http in") {
        const entry = getFamilyEntry(
          family,
          SDN_FLOW_EDITOR_RUNTIME_CLASSIFICATION.COMPILED,
        );
        entry.count += 1;
        entry.nodeIds.add(nodeId);
        entry.triggerIds.add(`trigger-${nodeId}`);
        classificationCounts.compiled += 1;
        totalNodes += 1;
        continue;
      }

      const runtimeNode = programNodesById.get(nodeId) ?? null;
      const invocationIdentity = deriveRuntimeInvocationIdentity(node, runtimeNode);
      const pluginId = normalizeString(invocationIdentity?.pluginId, null);
      const methodId = normalizeString(invocationIdentity?.methodId, null);
      const resolution = resolveRuntimePathClassification(nodeId, family, pluginId, methodId);

      const familyEntry = getFamilyEntry(family, resolution.classification);
      familyEntry.count += 1;
      familyEntry.nodeIds.add(nodeId);
      if (pluginId) {
        familyEntry.pluginIds.add(pluginId);
      }
      if (methodId) {
        familyEntry.methodIds.add(methodId);
      }
      if (resolution.handlerKey) {
        familyEntry.handlerKeys.add(resolution.handlerKey);
      }

      const handlerEntry = getHandlerEntry(
        resolution.handlerKey ??
          (pluginId && methodId && `${pluginId}:${methodId}`) ??
          pluginId ??
          methodId ??
          nodeId,
        resolution.classification,
      );
      handlerEntry.count += 1;
      handlerEntry.nodeIds.add(nodeId);
      handlerEntry.families.add(family);
      if (pluginId) {
        handlerEntry.pluginIds.add(pluginId);
      }
      if (methodId) {
        handlerEntry.methodIds.add(methodId);
      }

      classificationCounts[resolution.classification] += 1;
      totalNodes += 1;
    }

    const nodeFamilies = Array.from(familyEntries.values())
      .map((entry) => ({
        family: entry.family,
        classification: entry.classification,
        count: entry.count,
        nodeIds: Array.from(entry.nodeIds).sort(),
        triggerIds: Array.from(entry.triggerIds).sort(),
        pluginIds: Array.from(entry.pluginIds).sort(),
        methodIds: Array.from(entry.methodIds).sort(),
        handlerKeys: Array.from(entry.handlerKeys).sort(),
      }))
      .sort((left, right) =>
        left.family.localeCompare(right.family) ||
        left.classification.localeCompare(right.classification),
      );
    const handlers = Array.from(handlerEntries.values())
      .map((entry) => ({
        key: entry.key,
        classification: entry.classification,
        count: entry.count,
        nodeIds: Array.from(entry.nodeIds).sort(),
        families: Array.from(entry.families).sort(),
        pluginIds: Array.from(entry.pluginIds).sort(),
        methodIds: Array.from(entry.methodIds).sort(),
      }))
      .sort((left, right) =>
        String(left.key ?? "").localeCompare(String(right.key ?? "")) ||
        left.classification.localeCompare(right.classification),
      );

    return {
      summary: {
        totalNodes,
        families: nodeFamilies.length,
        handlers: handlers.length,
        byClassification: classificationCounts,
      },
      nodeFamilies,
      handlers,
    };
  }

  return {
    runtimeId,
    startup,
    runtimePaths,
    currentExecutablePath,

    bindHostLifecycle(nextLifecycle = {}) {
      lifecycle = {
        ...lifecycle,
        ...nextLifecycle,
      };
      return this;
    },

    getStartupSettings() {
      return { ...startup };
    },

    getSecuritySettings() {
      return cloneJsonCompatibleValue(securitySettings);
    },

    getFlowState() {
      return flowState;
    },

    async updateStartupSettings(nextSettings = {}) {
      const settingsRecord = normalizeSdnFlowEditorSettingsRecord(nextSettings, {
        startup,
        artifactArchiveLimit,
        security: securitySettings,
        projectRoot: runtimePaths.projectRoot,
      });
      const nextStartup = { ...settingsRecord.startup };
      const nextArtifactArchiveLimit = settingsRecord.artifactArchiveLimit;
      const nextSecuritySettings = cloneJsonCompatibleValue(settingsRecord.security);
      const nextSecurityStatus = await buildManagedSecurityState(
        nextStartup,
        nextSecuritySettings,
      );
      startup = nextStartup;
      artifactArchiveLimit = nextArtifactArchiveLimit;
      securitySettings = nextSecuritySettings;
      securityStatus = nextSecurityStatus;
      lastSecurityError = null;
      await writeSdnFlowEditorSettingsFile(runtimePaths.settingsFilePath, settingsRecord);
      return {
        startup: { ...startup },
        activeStartup: { ...activeStartup },
        security: cloneJsonCompatibleValue(securitySettings),
        activeSecurity: cloneJsonCompatibleValue(activeSecuritySettings),
        securityStatus: summarizeSecurityState(securityStatus, securitySettings),
        restartUrl: buildSdnFlowEditorUrl(startup),
        artifactArchiveLimit,
      };
    },

    setFlowState(nextState, metadata = {}) {
      flowState = normalizeFlowState(nextState, flowState);
      syncInjectSchedules();
      if (flowState !== "start") {
        stopSortStates();
        stopSplitStates();
        stopCsvStates();
        stopJoinStates();
        stopBatchStates();
        stopDelayStates();
        stopTriggerStates();
        stopLinkCallStates();
        stopExecProcesses();
      }
      return {
        state: flowState,
        ...metadata,
      };
    },

    getRuntimeStatus() {
      return {
        runtimeId,
        activeStartup: { ...activeStartup },
        startup: { ...startup },
        activeSecurity: cloneJsonCompatibleValue(activeSecuritySettings),
        security: cloneJsonCompatibleValue(securitySettings),
        securityStatus: summarizeSecurityState(securityStatus, securitySettings),
        flowState,
        compilePending: compileState !== null,
        compileId: compileState?.compileId ?? null,
        compileRequestedAt: compileState?.requestedAt ?? null,
        lastCompileError,
        lastSecurityError,
        restartUrl: buildSdnFlowEditorUrl(startup),
        settingsFilePath: runtimePaths.settingsFilePath,
        targetExecutablePath: runtimePaths.targetExecutablePath,
        currentExecutablePath,
        archiveDir: runtimePaths.archiveDir,
        currentBuildFilePath: runtimePaths.currentBuildFilePath,
        artifactArchiveDir: runtimePaths.artifactArchiveDir,
        artifactArchiveLimit,
        activeBuild: activeBuild
          ? {
              ...structuredClone(activeBuild.artifactSummary ?? {}),
              compileId: activeBuild.compileId,
              createdAt: activeBuild.createdAt,
              outputName: activeBuild.outputName,
              runtimeModel: activeBuild.runtimeModel,
              sourceGeneratorModel: activeBuild.sourceGeneratorModel,
              warnings: Array.isArray(activeBuild.warnings) ? [...activeBuild.warnings] : [],
            }
          : null,
        compiledRuntimeLoaded: Boolean(activeRuntimeHost && activeArtifact),
        lastArtifactLoadError,
        runtimeClassification: buildRuntimeClassificationStatus(),
        scheduledInjects: getScheduledInjectStatus(),
        debugSequence,
        debugMessages: debugMessages.map((entry) => structuredClone(entry)),
      };
    },

    async initialize() {
      try {
        await loadPersistedEditorSettings();
      } catch (error) {
        lastCompileError = formatErrorMessage(error);
        logError(lastCompileError);
      }
      try {
        await refreshActiveSecurityState();
      } catch (error) {
        lastSecurityError = formatErrorMessage(error);
        logError(lastSecurityError);
      }
      try {
        await refreshPendingSecurityStatus();
      } catch (error) {
        lastSecurityError = formatErrorMessage(error);
        logError(lastSecurityError);
      }
      try {
        await loadPersistedCompiledBuild();
      } catch (error) {
        lastArtifactLoadError = formatErrorMessage(error);
        logError(lastArtifactLoadError);
      }
      return this;
    },

    async listArchives() {
      return listArchivedSdnFlowEditorBuilds({
        projectRoot: runtimePaths.projectRoot,
      });
    },

    async deleteArchive(id) {
      return deleteArchivedSdnFlowEditorBuild(id, {
        projectRoot: runtimePaths.projectRoot,
      });
    },

    getActiveBuild() {
      return activeBuild ? structuredClone(activeBuild) : null;
    },

    getActiveArtifact() {
      return activeArtifact ?? null;
    },

    async readActiveArtifactWasm() {
      return activeArtifact?.wasm ? new Uint8Array(activeArtifact.wasm) : null;
    },

    getActiveRuntimeHost() {
      return activeRuntimeHost ?? null;
    },

    async ensureSecurityState() {
      if (!activeSecurityState) {
        activeSecurityState = await buildManagedSecurityState(
          activeStartup,
          activeSecuritySettings,
        );
      }
      return activeSecurityState;
    },

    getTargetExecutablePath() {
      return runtimePaths.targetExecutablePath;
    },

    async dispatchInject(nodeId, overrideMessage = null) {
      return dispatchInjectNode(nodeId, overrideMessage);
    },

    async handleHttpRequest(request = {}) {
      return queueRuntimeDispatch(async () => {
        if (!activeRuntimeHost || !activeBuild?.program) {
          throw createSdnFlowEditorRuntimeHttpError(
            "SDN_FLOW_HTTP_RUNTIME_UNAVAILABLE",
            "No compiled flow runtime is loaded. Compile the flow first.",
            503,
          );
        }
        if (flowState !== "start") {
          throw createSdnFlowEditorRuntimeHttpError(
            "SDN_FLOW_HTTP_FLOWS_STOPPED",
            "Flows are stopped.",
            503,
          );
        }
        const routeRecord = resolveHttpTriggerRoute(request);
        const triggerIndex = getTriggerIndexById(routeRecord.triggerId);
        if (triggerIndex < 0) {
          throw createSdnFlowEditorRuntimeHttpError(
            "SDN_FLOW_HTTP_TRIGGER_NOT_FOUND",
            `No HTTP trigger matches ${routeRecord.requestMethod} ${routeRecord.requestPath}.`,
            404,
          );
        }
        const requestMessage = buildHttpRequestMessage(routeRecord, request);
        activeRuntimeHost.enqueueTriggerFrame(triggerIndex, {
          typeRef: SDN_FLOW_EDITOR_RUNTIME_MESSAGE_TYPE,
          bytes: encodeRuntimePayload(requestMessage),
          metadata: {
            requestId: requestMessage.req?.requestId ?? null,
            method: requestMessage.req?.method ?? null,
            path: requestMessage.req?.path ?? null,
          },
        });
        const drainResult = await activeRuntimeHost.drain({
          maxIterations: 1024,
          outputStreamCap: 32,
        });
        return {
          triggerId: routeRecord.triggerId,
          route: routeRecord.routePath,
          params: cloneJsonCompatibleValue(routeRecord.params ?? {}),
          outputs: collectHttpResponseOutputs(drainResult),
          ...drainResult,
        };
      });
    },

    setDebugNodeState(nodeIds, active) {
      return setDebugNodeState(nodeIds, active);
    },

    async scheduleCompile(flows) {
      if (compileState) {
        return {
          compileId: compileState.compileId,
          alreadyPending: true,
        };
      }

      const compileId = `compile-${Date.now().toString(36)}`;
      compileState = {
        compileId,
        requestedAt: new Date().toISOString(),
      };

      const sessionPayload = {
        kind: "sdn-flow-editor-session",
        version: 1,
        runtimeId,
        startup: { ...startup },
        security: cloneJsonCompatibleValue(securitySettings),
        flows,
      };
      try {
        await writeSdnFlowEditorSessionFile(runtimePaths.sessionFilePath, sessionPayload);
      } catch (error) {
        compileState = null;
        throw error;
      }
      lastCompileError = null;
      compilePromise = runCompileLifecycle(flows, compileId);

      return {
        compileId,
        requestedAt: compileState.requestedAt,
        sessionFilePath: runtimePaths.sessionFilePath,
        restartUrl: restartAfterCompile ? buildSdnFlowEditorUrl(startup) : null,
        restartPending: restartAfterCompile,
      };
    },

    async waitForActiveCompile() {
      await compilePromise;
    },
  };
}

export default {
  applySdnFlowEditorChangeNodeMessage,
  applySdnFlowEditorJsonNodeMessage,
  buildSdnFlowEditorUrl,
  archiveSdnFlowEditorExecutable,
  createSdnFlowEditorRuntimeManager,
  deleteArchivedSdnFlowEditorBuild,
  deleteArchivedSdnFlowEditorExecutable,
  getSdnFlowEditorRuntimePaths,
  listArchivedSdnFlowEditorBuilds,
  listArchivedSdnFlowEditorExecutables,
  readSdnFlowEditorBuildFile,
  readSdnFlowEditorSettingsFile,
  readSdnFlowEditorSessionFile,
  replaceSdnFlowEditorExecutable,
  resolveSdnFlowEditorProjectRoot,
  writeSdnFlowEditorBuildFile,
  writeSdnFlowEditorSettingsFile,
  writeSdnFlowEditorSessionFile,
};
