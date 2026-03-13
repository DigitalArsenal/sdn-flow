import { DrainPolicy } from "./constants.js";
import { normalizeFrame, normalizeManifest } from "./normalize.js";

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

function typeMatches(acceptedType, frameType) {
  if (!acceptedType) {
    return false;
  }
  if (acceptedType.acceptsAnyFlatbuffer === true) {
    return true;
  }
  if (!frameType) {
    return false;
  }
  if (
    acceptedType.schemaName &&
    acceptedType.schemaName !== frameType.schemaName
  ) {
    return false;
  }
  if (
    acceptedType.fileIdentifier &&
    acceptedType.fileIdentifier !== frameType.fileIdentifier
  ) {
    return false;
  }
  if (
    Array.isArray(acceptedType.schemaHash) &&
    acceptedType.schemaHash.length > 0
  ) {
    if (
      !Array.isArray(frameType.schemaHash) ||
      frameType.schemaHash.length !== acceptedType.schemaHash.length
    ) {
      return false;
    }
    for (let index = 0; index < acceptedType.schemaHash.length; index += 1) {
      if (acceptedType.schemaHash[index] !== frameType.schemaHash[index]) {
        return false;
      }
    }
  }
  return true;
}

function portAcceptsFrame(port, frame) {
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
      if (typeMatches(acceptedType, frame.typeRef)) {
        return true;
      }
    }
  }
  return false;
}

function hydrateOutputPorts(response, method, outputStreamCap) {
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

    const normalizedInputs = Array.isArray(inputs)
      ? inputs.map((frame) => normalizeFrame(frame))
      : [];
    const inputsByPort = groupFramesByPort(normalizedInputs);

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
        if (!portAcceptsFrame(port, frame)) {
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
      inputs: normalizedInputs,
      inputsByPort,
      outputStreamCap,
      drainPolicy: requestedDrainPolicy,
      context,
    });

    return hydrateOutputPorts(result ?? {}, descriptor.method, outputStreamCap);
  }

  clear() {
    this.#plugins.clear();
    this.#methods.clear();
  }
}

export default MethodRegistry;
