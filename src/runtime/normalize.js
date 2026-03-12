import {
  BackpressurePolicy,
  DefaultManifestExports,
  DrainPolicy,
  NodeKind,
  TriggerKind,
} from "./constants.js";

function normalizeString(value, fallback = null) {
  if (value === null || value === undefined) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeArray(values) {
  return Array.isArray(values) ? values : [];
}

function normalizeTypeRef(typeRef = {}) {
  return {
    schemaName: normalizeString(typeRef.schemaName ?? typeRef.schema_name, null),
    fileIdentifier: normalizeString(
      typeRef.fileIdentifier ?? typeRef.file_identifier,
      null,
    ),
    schemaHash: normalizeArray(typeRef.schemaHash ?? typeRef.schema_hash),
    acceptsAnyFlatbuffer:
      typeRef.acceptsAnyFlatbuffer ?? typeRef.accepts_any_flatbuffer ?? false,
  };
}

function normalizeAcceptedTypeSet(typeSet = {}) {
  return {
    setId: normalizeString(typeSet.setId ?? typeSet.set_id, null),
    allowedTypes: normalizeArray(
      typeSet.allowedTypes ?? typeSet.allowed_types,
    ).map(normalizeTypeRef),
    description: normalizeString(typeSet.description, null),
  };
}

function normalizePort(port = {}) {
  return {
    portId: normalizeString(port.portId ?? port.port_id, ""),
    displayName: normalizeString(port.displayName ?? port.display_name, null),
    acceptedTypeSets: normalizeArray(
      port.acceptedTypeSets ?? port.accepted_type_sets,
    ).map(normalizeAcceptedTypeSet),
    minStreams: Math.max(0, Number(port.minStreams ?? port.min_streams ?? 1)),
    maxStreams: Math.max(0, Number(port.maxStreams ?? port.max_streams ?? 1)),
    required: port.required !== false,
    description: normalizeString(port.description, null),
  };
}

function normalizeMethod(method = {}) {
  return {
    methodId: normalizeString(method.methodId ?? method.method_id, ""),
    displayName: normalizeString(method.displayName ?? method.display_name, null),
    inputPorts: normalizeArray(method.inputPorts ?? method.input_ports).map(
      normalizePort,
    ),
    outputPorts: normalizeArray(method.outputPorts ?? method.output_ports).map(
      normalizePort,
    ),
    maxBatch: Math.max(1, Number(method.maxBatch ?? method.max_batch ?? 1)),
    drainPolicy:
      normalizeString(method.drainPolicy ?? method.drain_policy, null) ??
      DrainPolicy.DRAIN_UNTIL_YIELD,
    description: normalizeString(method.description, null),
  };
}

export function normalizeManifest(manifest = {}) {
  return {
    pluginId: normalizeString(manifest.pluginId ?? manifest.plugin_id, ""),
    name: normalizeString(manifest.name, null),
    version: normalizeString(manifest.version, null),
    pluginFamily: normalizeString(
      manifest.pluginFamily ?? manifest.plugin_family,
      null,
    ),
    methods: normalizeArray(manifest.methods).map(normalizeMethod),
    capabilities: normalizeArray(manifest.capabilities),
    timers: normalizeArray(manifest.timers),
    protocols: normalizeArray(manifest.protocols),
    schemasUsed: normalizeArray(
      manifest.schemasUsed ?? manifest.schemas_used,
    ).map(normalizeTypeRef),
    buildArtifacts: normalizeArray(
      manifest.buildArtifacts ?? manifest.build_artifacts,
    ),
    manifestBuffer: manifest.manifestBuffer ?? manifest.manifest_buffer ?? null,
    manifestExports: {
      bytesSymbol:
        normalizeString(
          manifest.manifestExports?.bytesSymbol ??
            manifest.manifest_exports?.bytes_symbol,
          null,
        ) ?? DefaultManifestExports.pluginBytesSymbol,
      sizeSymbol:
        normalizeString(
          manifest.manifestExports?.sizeSymbol ??
            manifest.manifest_exports?.size_symbol,
          null,
        ) ?? DefaultManifestExports.pluginSizeSymbol,
    },
  };
}

function normalizeTrigger(trigger = {}) {
  return {
    triggerId: normalizeString(trigger.triggerId ?? trigger.trigger_id, ""),
    kind:
      normalizeString(trigger.kind, null) ?? TriggerKind.MANUAL,
    source: normalizeString(trigger.source, null),
    protocolId: normalizeString(trigger.protocolId ?? trigger.protocol_id, null),
    defaultIntervalMs: Number(
      trigger.defaultIntervalMs ?? trigger.default_interval_ms ?? 0,
    ),
    acceptedTypes: normalizeArray(
      trigger.acceptedTypes ?? trigger.accepted_types,
    ).map(normalizeTypeRef),
    description: normalizeString(trigger.description, null),
  };
}

function normalizeNode(node = {}) {
  return {
    nodeId: normalizeString(node.nodeId ?? node.node_id, ""),
    pluginId: normalizeString(node.pluginId ?? node.plugin_id, ""),
    methodId: normalizeString(node.methodId ?? node.method_id, ""),
    kind:
      normalizeString(node.kind, null) ?? NodeKind.TRANSFORM,
    drainPolicy:
      normalizeString(node.drainPolicy ?? node.drain_policy, null) ??
      DrainPolicy.DRAIN_UNTIL_YIELD,
    timeSliceMicros: Number(node.timeSliceMicros ?? node.time_slice_micros ?? 0),
  };
}

function normalizeEdge(edge = {}) {
  return {
    edgeId: normalizeString(edge.edgeId ?? edge.edge_id, ""),
    fromNodeId: normalizeString(edge.fromNodeId ?? edge.from_node_id, ""),
    fromPortId: normalizeString(edge.fromPortId ?? edge.from_port_id, ""),
    toNodeId: normalizeString(edge.toNodeId ?? edge.to_node_id, ""),
    toPortId: normalizeString(edge.toPortId ?? edge.to_port_id, ""),
    acceptedTypes: normalizeArray(
      edge.acceptedTypes ?? edge.accepted_types,
    ).map(normalizeTypeRef),
    backpressurePolicy:
      normalizeString(
        edge.backpressurePolicy ?? edge.backpressure_policy,
        null,
      ) ?? BackpressurePolicy.QUEUE,
    queueDepth: Math.max(0, Number(edge.queueDepth ?? edge.queue_depth ?? 1)),
  };
}

function normalizeTriggerBinding(binding = {}) {
  return {
    triggerId: normalizeString(binding.triggerId ?? binding.trigger_id, ""),
    targetNodeId: normalizeString(
      binding.targetNodeId ?? binding.target_node_id,
      "",
    ),
    targetPortId: normalizeString(
      binding.targetPortId ?? binding.target_port_id,
      "",
    ),
    backpressurePolicy:
      normalizeString(
        binding.backpressurePolicy ?? binding.backpressure_policy,
        null,
      ) ?? BackpressurePolicy.QUEUE,
    queueDepth: Math.max(
      0,
      Number(binding.queueDepth ?? binding.queue_depth ?? 1),
    ),
  };
}

export function normalizeProgram(program = {}) {
  return {
    programId: normalizeString(program.programId ?? program.program_id, ""),
    name: normalizeString(program.name, null),
    version: normalizeString(program.version, null),
    nodes: normalizeArray(program.nodes).map(normalizeNode),
    edges: normalizeArray(program.edges).map(normalizeEdge),
    triggers: normalizeArray(program.triggers).map(normalizeTrigger),
    triggerBindings: normalizeArray(
      program.triggerBindings ?? program.trigger_bindings,
    ).map(normalizeTriggerBinding),
    requiredPlugins: normalizeArray(
      program.requiredPlugins ?? program.required_plugins,
    ).map((pluginId) => normalizeString(pluginId, null)).filter(Boolean),
    description: normalizeString(program.description, null),
  };
}

export function normalizeFrame(frame = {}, defaultPortId = null) {
  const normalized = {
    typeRef: normalizeTypeRef(frame.typeRef ?? frame.type_ref ?? {}),
    portId:
      normalizeString(frame.portId ?? frame.port_id, null) ?? defaultPortId,
    alignment: Math.max(1, Number(frame.alignment ?? 8)),
    offset: Math.max(0, Number(frame.offset ?? 0)),
    size: Math.max(0, Number(frame.size ?? 0)),
    ownership: normalizeString(frame.ownership, null),
    generation: Number(frame.generation ?? 0),
    mutability: normalizeString(frame.mutability, null),
    traceId: frame.traceId ?? frame.trace_id ?? null,
    streamId: Number(frame.streamId ?? frame.stream_id ?? 0),
    sequence: frame.sequence ?? 0,
    endOfStream: frame.endOfStream ?? frame.end_of_stream ?? false,
  };
  return normalized;
}
