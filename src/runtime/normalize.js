import {
  BackpressurePolicy,
  DefaultManifestExports,
  DrainPolicy,
  ExternalInterfaceDirection,
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
    schemaName: normalizeString(
      typeRef.schemaName ?? typeRef.schema_name,
      null,
    ),
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

function normalizeExternalInterface(externalInterface = {}) {
  return {
    interfaceId: normalizeString(
      externalInterface.interfaceId ?? externalInterface.interface_id,
      "",
    ),
    kind: normalizeString(externalInterface.kind, null),
    direction:
      normalizeString(externalInterface.direction, null) ??
      ExternalInterfaceDirection.BIDIRECTIONAL,
    capability: normalizeString(externalInterface.capability, null),
    resource: normalizeString(externalInterface.resource, null),
    protocolId: normalizeString(
      externalInterface.protocolId ?? externalInterface.protocol_id,
      null,
    ),
    topic: normalizeString(externalInterface.topic, null),
    path: normalizeString(externalInterface.path, null),
    description: normalizeString(externalInterface.description, null),
    required: externalInterface.required !== false,
    acceptedTypes: normalizeArray(
      externalInterface.acceptedTypes ?? externalInterface.accepted_types,
    ).map(normalizeTypeRef),
    properties:
      externalInterface.properties &&
      typeof externalInterface.properties === "object"
        ? { ...externalInterface.properties }
        : {},
  };
}

function normalizeArtifactDependency(dependency = {}) {
  return {
    dependencyId: normalizeString(
      dependency.dependencyId ?? dependency.dependency_id,
      "",
    ),
    pluginId: normalizeString(
      dependency.pluginId ?? dependency.plugin_id,
      null,
    ),
    version: normalizeString(dependency.version, null),
    artifactId: normalizeString(
      dependency.artifactId ?? dependency.artifact_id,
      null,
    ),
    artifactUri: normalizeString(
      dependency.artifactUri ?? dependency.artifact_uri,
      null,
    ),
    mediaType:
      normalizeString(dependency.mediaType ?? dependency.media_type, null) ??
      "application/wasm",
    sha256: normalizeString(dependency.sha256, null),
    manifestHash: normalizeString(
      dependency.manifestHash ?? dependency.manifest_hash,
      null,
    ),
    signature: normalizeString(dependency.signature, null),
    signerPublicKey: normalizeString(
      dependency.signerPublicKey ?? dependency.signer_public_key,
      null,
    ),
    entrypoint: normalizeString(dependency.entrypoint, null),
    requiredCapabilities: normalizeArray(
      dependency.requiredCapabilities ?? dependency.required_capabilities,
    )
      .map((value) => normalizeString(value, null))
      .filter(Boolean),
    exports: normalizeArray(dependency.exports)
      .map((value) => normalizeString(value, null))
      .filter(Boolean),
    manifestExports: {
      bytesSymbol:
        normalizeString(
          dependency.manifestExports?.bytesSymbol ??
            dependency.manifest_exports?.bytes_symbol,
          null,
        ) ?? DefaultManifestExports.pluginBytesSymbol,
      sizeSymbol:
        normalizeString(
          dependency.manifestExports?.sizeSymbol ??
            dependency.manifest_exports?.size_symbol,
          null,
        ) ?? DefaultManifestExports.pluginSizeSymbol,
    },
    runtimeExports: {
      initSymbol:
        normalizeString(
          dependency.runtimeExports?.initSymbol ??
            dependency.runtime_exports?.init_symbol,
          null,
        ) ?? "plugin_init",
      destroySymbol:
        normalizeString(
          dependency.runtimeExports?.destroySymbol ??
            dependency.runtime_exports?.destroy_symbol,
          null,
        ) ?? "plugin_destroy",
      mallocSymbol:
        normalizeString(
          dependency.runtimeExports?.mallocSymbol ??
            dependency.runtime_exports?.malloc_symbol,
          null,
        ) ?? "malloc",
      freeSymbol:
        normalizeString(
          dependency.runtimeExports?.freeSymbol ??
            dependency.runtime_exports?.free_symbol,
          null,
        ) ?? "free",
      streamInvokeSymbol: normalizeString(
        dependency.runtimeExports?.streamInvokeSymbol ??
          dependency.runtime_exports?.stream_invoke_symbol,
        null,
      ),
    },
    metadata:
      dependency.metadata && typeof dependency.metadata === "object"
        ? { ...dependency.metadata }
        : {},
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
    displayName: normalizeString(
      method.displayName ?? method.display_name,
      null,
    ),
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
    externalInterfaces: normalizeArray(
      manifest.externalInterfaces ?? manifest.external_interfaces,
    ).map(normalizeExternalInterface),
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
    kind: normalizeString(trigger.kind, null) ?? TriggerKind.MANUAL,
    source: normalizeString(trigger.source, null),
    protocolId: normalizeString(
      trigger.protocolId ?? trigger.protocol_id,
      null,
    ),
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
    kind: normalizeString(node.kind, null) ?? NodeKind.TRANSFORM,
    drainPolicy:
      normalizeString(node.drainPolicy ?? node.drain_policy, null) ??
      DrainPolicy.DRAIN_UNTIL_YIELD,
    timeSliceMicros: Number(
      node.timeSliceMicros ?? node.time_slice_micros ?? 0,
    ),
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
    )
      .map((pluginId) => normalizeString(pluginId, null))
      .filter(Boolean),
    externalInterfaces: normalizeArray(
      program.externalInterfaces ?? program.external_interfaces,
    ).map(normalizeExternalInterface),
    artifactDependencies: normalizeArray(
      program.artifactDependencies ?? program.artifact_dependencies,
    ).map(normalizeArtifactDependency),
    editor:
      program.editor && typeof program.editor === "object"
        ? structuredClone(program.editor)
        : null,
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
    payload: frame.payload ?? null,
    metadata:
      frame.metadata && typeof frame.metadata === "object"
        ? structuredClone(frame.metadata)
        : null,
  };
  return normalized;
}

export { normalizeExternalInterface, normalizeArtifactDependency };
