import { DrainPolicy } from "./constants.js";
import {
  clonePayloadTypeRef,
  normalizePayloadWireFormatName,
  payloadTypeRefsMatch,
  selectPreferredPayloadTypeRef,
} from "space-data-module-sdk";
import { normalizeFrame, normalizeManifest } from "./normalize.js";

const INTERNAL_ALIGNED_BINARY_EXCEPTION_INTERFACE_KINDS = new Set([
  "filesystem",
  "database",
  "host-service",
  "network",
  "tcp",
  "udp",
  "tls",
  "websocket",
  "mqtt",
]);

const INTERNAL_ALIGNED_BINARY_EXCEPTION_CAPABILITIES = new Set([
  "filesystem",
  "network",
  "storage_query",
  "storage_write",
  "storage_adapter",
]);

function groupFramesByPort(frames) {
  const grouped = new Map();
  for (const frame of frames) {
    if (!frame.portId) {
      throw new Error("Flow frame is missing portId.");
    }
    const bucket = grouped.get(frame.portId);
    if (bucket) {
      bucket.push(frame);
    } else {
      grouped.set(frame.portId, [frame]);
    }
  }
  return grouped;
}

function countDistinctStreams(frames) {
  const streamIds = new Set();
  for (const frame of frames) {
    streamIds.add(Number(frame.streamId ?? 0));
  }
  return streamIds.size;
}

function buildPortMap(ports) {
  const map = new Map();
  for (const port of ports) {
    map.set(port.portId, port);
  }
  return map;
}

function hasMeaningfulTypeRef(typeRef = null) {
  if (!typeRef || typeof typeRef !== "object") {
    return false;
  }
  const normalized = clonePayloadTypeRef(typeRef);
  return Boolean(
    normalized.acceptsAnyFlatbuffer === true ||
      normalized.schemaName ||
      normalized.fileIdentifier ||
      (Array.isArray(normalized.schemaHash) && normalized.schemaHash.length > 0) ||
      normalized.schemaHash instanceof Uint8Array,
  );
}

function cloneTypeRefWithoutWireFormat(typeRef = null) {
  const normalized = clonePayloadTypeRef(typeRef);
  delete normalized.wireFormat;
  delete normalized.rootTypeName;
  delete normalized.fixedStringLength;
  delete normalized.byteLength;
  delete normalized.requiredAlignment;
  return normalized;
}

function typeMatches(acceptedType, frameType, options = {}) {
  if (payloadTypeRefsMatch(acceptedType, frameType)) {
    return true;
  }
  if (options.internalTransport !== true) {
    return false;
  }
  return payloadTypeRefsMatch(acceptedType, frameType);
}

function portAcceptsFrame(port, frame, options = {}) {
  const acceptedTypeSets = Array.isArray(port.acceptedTypeSets)
    ? port.acceptedTypeSets
    : [];
  if (acceptedTypeSets.length === 0) {
    return true;
  }
  for (const typeSet of acceptedTypeSets) {
    const allowedTypes = Array.isArray(typeSet.allowedTypes)
      ? typeSet.allowedTypes
      : [];
    for (const acceptedType of allowedTypes) {
      if (typeMatches(acceptedType, frame.typeRef, options)) {
        return true;
      }
      if (
        options.internalTransport === true &&
        payloadTypeRefsMatch(
          cloneTypeRefWithoutWireFormat(acceptedType),
          cloneTypeRefWithoutWireFormat(frame.typeRef),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function methodUsesExternalTransportException(manifest = {}) {
  if (
    Array.isArray(manifest.capabilities) &&
    manifest.capabilities.some((capability) =>
      INTERNAL_ALIGNED_BINARY_EXCEPTION_CAPABILITIES.has(capability),
    )
  ) {
    return true;
  }
  return Array.isArray(manifest.externalInterfaces) &&
    manifest.externalInterfaces.some((externalInterface) =>
      INTERNAL_ALIGNED_BINARY_EXCEPTION_INTERFACE_KINDS.has(externalInterface?.kind),
    );
}

function coerceImplicitAlignedBinaryTypeRef(
  typeRef = null,
  frame = {},
  preferredTypeRef = null,
) {
  const baseTypeRef = hasMeaningfulTypeRef(typeRef)
    ? clonePayloadTypeRef(typeRef)
    : hasMeaningfulTypeRef(preferredTypeRef)
      ? clonePayloadTypeRef(preferredTypeRef)
      : clonePayloadTypeRef(typeRef);
  const explicitWireFormat = normalizePayloadWireFormatName(baseTypeRef.wireFormat);
  if (
    explicitWireFormat !== null ||
    !hasMeaningfulTypeRef(baseTypeRef)
  ) {
    return baseTypeRef;
  }
  baseTypeRef.wireFormat = "aligned-binary";
  if (baseTypeRef.requiredAlignment === undefined) {
    const alignment = Number(frame.alignment ?? 8);
    if (Number.isFinite(alignment) && alignment > 0) {
      baseTypeRef.requiredAlignment = Math.max(1, Math.trunc(alignment));
    }
  }
  return baseTypeRef;
}

function applyInternalTransportDefaultsToInputs(frames = []) {
  return frames.map((frame) => ({
    ...frame,
    typeRef: coerceImplicitAlignedBinaryTypeRef(frame.typeRef, frame),
  }));
}

function hydrateOutputPorts(response, method, outputStreamCap, options = {}) {
  const outputs = Array.isArray(response.outputs) ? response.outputs : [];
  if (outputStreamCap > 0 && outputs.length > outputStreamCap) {
    throw new Error(
      `Method "${method.methodId}" produced ${outputs.length} output frames, exceeding outputStreamCap ${outputStreamCap}.`,
    );
  }
  if (method.outputPorts.length === 1) {
    const onlyPortId = method.outputPorts[0].portId;
    for (const frame of outputs) {
      if (!frame.portId) {
        frame.portId = onlyPortId;
      }
    }
  }
  for (const frame of outputs) {
    if (!frame.portId) {
      throw new Error(
        `Method "${method.methodId}" produced a frame without portId and has multiple output ports.`,
      );
    }
  }
  if (options.internalTransport === true && options.exceptionPlugin !== true) {
    const outputPorts = buildPortMap(method.outputPorts);
    for (const frame of outputs) {
      const outputPort = outputPorts.get(frame.portId) ?? null;
      const preferredTypeRef = outputPort
        ? selectPreferredPayloadTypeRef(outputPort, {
            preferredWireFormat: "aligned-binary",
          })
        : null;
      frame.typeRef = coerceImplicitAlignedBinaryTypeRef(
        frame.typeRef,
        frame,
        preferredTypeRef,
      );
    }
  }
  return {
    outputs,
    backlogRemaining: Number(response.backlogRemaining ?? 0),
    yielded: response.yielded === true,
    errorCode: Number(response.errorCode ?? 0),
    errorMessage: response.errorMessage ?? null,
  };
}

export class MethodRegistry {
  #plugins = new Map();

  #methods = new Map();

  registerPlugin({ manifest, handlers = {}, plugin = null }) {
    const normalizedManifest = normalizeManifest(manifest);
    if (!normalizedManifest.pluginId) {
      throw new Error("Plugin manifest is missing pluginId.");
    }
    if (this.#plugins.has(normalizedManifest.pluginId)) {
      throw new Error(
        `Plugin "${normalizedManifest.pluginId}" is already registered.`,
      );
    }

    const methodMap = new Map();
    for (const method of normalizedManifest.methods) {
      if (!method.methodId) {
        throw new Error(
          `Plugin "${normalizedManifest.pluginId}" contains a method without methodId.`,
        );
      }
      const handler = handlers[method.methodId];
      if (typeof handler !== "function") {
        throw new Error(
          `Plugin "${normalizedManifest.pluginId}" is missing a handler for method "${method.methodId}".`,
        );
      }
      const descriptor = {
        pluginId: normalizedManifest.pluginId,
        manifest: normalizedManifest,
        method,
        handler,
        plugin,
        inputPorts: buildPortMap(method.inputPorts),
        outputPorts: buildPortMap(method.outputPorts),
      };
      methodMap.set(method.methodId, descriptor);
      this.#methods.set(
        `${normalizedManifest.pluginId}:${method.methodId}`,
        descriptor,
      );
    }

    const record = {
      pluginId: normalizedManifest.pluginId,
      manifest: normalizedManifest,
      methods: methodMap,
      plugin,
    };
    this.#plugins.set(normalizedManifest.pluginId, record);
    return record;
  }

  unregisterPlugin(pluginId) {
    const record = this.#plugins.get(pluginId);
    if (!record) {
      return false;
    }

    this.#plugins.delete(pluginId);
    for (const methodId of record.methods.keys()) {
      this.#methods.delete(`${pluginId}:${methodId}`);
    }
    return true;
  }

  getPlugin(pluginId) {
    return this.#plugins.get(pluginId) ?? null;
  }

  getMethod(pluginId, methodId) {
    return this.#methods.get(`${pluginId}:${methodId}`) ?? null;
  }

  listPlugins() {
    return Array.from(this.#plugins.values());
  }

  async invoke({
    pluginId,
    methodId,
    inputs = [],
    outputStreamCap = 0,
    drainPolicy = undefined,
    context = undefined,
  }) {
    const descriptor = this.getMethod(pluginId, methodId);
    if (!descriptor) {
      throw new Error(`Unknown method "${pluginId}:${methodId}".`);
    }

    const internalTransport = context?.internalTransport === true;
    const exceptionPlugin = methodUsesExternalTransportException(
      descriptor.manifest,
    );

    const normalizedInputs = Array.isArray(inputs)
      ? inputs.map((frame) => normalizeFrame(frame))
      : [];
    const adaptedInputs =
      internalTransport && !exceptionPlugin
        ? applyInternalTransportDefaultsToInputs(normalizedInputs)
        : normalizedInputs;
    const inputsByPort = groupFramesByPort(adaptedInputs);

    for (const [portId, port] of descriptor.inputPorts.entries()) {
      const frames = inputsByPort.get(portId) ?? [];
      if (port.required && frames.length === 0) {
        throw new Error(
          `Method "${pluginId}:${methodId}" requires input port "${portId}".`,
        );
      }
      if (frames.length === 0) {
        continue;
      }
      const distinctStreams = countDistinctStreams(frames);
      if (distinctStreams < port.minStreams) {
        throw new Error(
          `Input port "${portId}" requires at least ${port.minStreams} stream(s).`,
        );
      }
      if (port.maxStreams > 0 && distinctStreams > port.maxStreams) {
        throw new Error(
          `Input port "${portId}" allows at most ${port.maxStreams} stream(s).`,
        );
      }
      for (const frame of frames) {
        if (!portAcceptsFrame(port, frame, { internalTransport })) {
          const schemaName =
            frame.typeRef?.schemaName ??
            frame.typeRef?.fileIdentifier ??
            "<unknown>";
          throw new Error(
            `Input port "${portId}" rejected frame type "${schemaName}".`,
          );
        }
      }
    }

    for (const portId of inputsByPort.keys()) {
      if (!descriptor.inputPorts.has(portId)) {
        throw new Error(
          `Method "${pluginId}:${methodId}" does not declare input port "${portId}".`,
        );
      }
    }

    const requestedDrainPolicy =
      drainPolicy ??
      descriptor.method.drainPolicy ??
      DrainPolicy.DRAIN_UNTIL_YIELD;

    const result = await descriptor.handler({
      pluginId,
      methodId,
      manifest: descriptor.manifest,
      method: descriptor.method,
      plugin: descriptor.plugin,
      inputs: adaptedInputs,
      inputsByPort,
      outputStreamCap,
      drainPolicy: requestedDrainPolicy,
      context,
    });

    return hydrateOutputPorts(result ?? {}, descriptor.method, outputStreamCap, {
      internalTransport,
      exceptionPlugin,
    });
  }

  clear() {
    this.#plugins.clear();
    this.#methods.clear();
  }
}

export default MethodRegistry;
