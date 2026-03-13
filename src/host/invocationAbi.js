import {
  bindCompiledRuntimeAbi,
  DefaultRequiredRuntimeExportRoles,
} from "./runtimeAbi.js";

export const FlowFrameDescriptorLayout = Object.freeze({
  size: 48,
  ingressIndexOffset: 0,
  typeDescriptorIndexOffset: 4,
  alignmentOffset: 8,
  offsetOffset: 12,
  sizeOffset: 16,
  streamIdOffset: 20,
  sequenceOffset: 24,
  traceTokenOffset: 32,
  endOfStreamOffset: 40,
  occupiedOffset: 41,
});

export const FlowInvocationDescriptorLayout = Object.freeze({
  size: 24,
  nodeIndexOffset: 0,
  dispatchDescriptorIndexOffset: 4,
  pluginIdPointerOffset: 8,
  methodIdPointerOffset: 12,
  framesPointerOffset: 16,
  frameCountOffset: 20,
});

export const DefaultRequiredInvocationExportRoles = Object.freeze([
  ...DefaultRequiredRuntimeExportRoles,
  "mallocSymbol",
  "freeSymbol",
  "ingressFrameDescriptorsSymbol",
  "ingressFrameDescriptorCountSymbol",
  "currentInvocationDescriptorSymbol",
  "prepareInvocationDescriptorSymbol",
  "enqueueTriggerFrameSymbol",
  "enqueueEdgeFrameSymbol",
]);

const INVALID_INDEX = 0xffffffff;

function resolveMemory(bound, explicitMemory = null) {
  const memory =
    explicitMemory ??
    bound?.wasmExports?.memory ??
    bound?.artifact?.wasmMemory ??
    null;
  if (!memory || !(memory.buffer instanceof ArrayBuffer)) {
    throw new Error(
      "Compiled invocation ABI requires a WebAssembly.Memory export.",
    );
  }
  return memory;
}

function readCString(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const bytes = new Uint8Array(memory.buffer);
  let end = pointer >>> 0;
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }
  return new TextDecoder().decode(bytes.subarray(pointer >>> 0, end));
}

function readFrameDescriptor(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  return {
    ingressIndex: view.getUint32(
      base + FlowFrameDescriptorLayout.ingressIndexOffset,
      true,
    ),
    typeDescriptorIndex: view.getUint32(
      base + FlowFrameDescriptorLayout.typeDescriptorIndexOffset,
      true,
    ),
    alignment: view.getUint32(
      base + FlowFrameDescriptorLayout.alignmentOffset,
      true,
    ),
    offset: view.getUint32(base + FlowFrameDescriptorLayout.offsetOffset, true),
    size: view.getUint32(base + FlowFrameDescriptorLayout.sizeOffset, true),
    streamId: view.getUint32(
      base + FlowFrameDescriptorLayout.streamIdOffset,
      true,
    ),
    sequence: view.getUint32(
      base + FlowFrameDescriptorLayout.sequenceOffset,
      true,
    ),
    traceToken: Number(
      view.getBigUint64(
        base + FlowFrameDescriptorLayout.traceTokenOffset,
        true,
      ),
    ),
    endOfStream:
      view.getUint8(base + FlowFrameDescriptorLayout.endOfStreamOffset) !== 0,
    occupied:
      view.getUint8(base + FlowFrameDescriptorLayout.occupiedOffset) !== 0,
  };
}

function writeFrameDescriptor(memory, pointer, frame = {}) {
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  view.setUint32(
    base + FlowFrameDescriptorLayout.ingressIndexOffset,
    Number(frame.ingressIndex ?? frame.ingress_index ?? INVALID_INDEX) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.typeDescriptorIndexOffset,
    Number(
      frame.typeDescriptorIndex ?? frame.type_descriptor_index ?? INVALID_INDEX,
    ) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.alignmentOffset,
    Number(frame.alignment ?? 8) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.offsetOffset,
    Number(frame.offset ?? 0) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.sizeOffset,
    Number(frame.size ?? 0) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.streamIdOffset,
    Number(frame.streamId ?? frame.stream_id ?? 0) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.sequenceOffset,
    Number(frame.sequence ?? 0) >>> 0,
    true,
  );
  view.setBigUint64(
    base + FlowFrameDescriptorLayout.traceTokenOffset,
    BigInt(Number(frame.traceToken ?? frame.trace_token ?? 0)),
    true,
  );
  view.setUint8(
    base + FlowFrameDescriptorLayout.endOfStreamOffset,
    (frame.endOfStream ?? frame.end_of_stream) ? 1 : 0,
  );
  view.setUint8(base + FlowFrameDescriptorLayout.occupiedOffset, 1);
}

function readInvocationDescriptor(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  const frameCount = view.getUint32(
    base + FlowInvocationDescriptorLayout.frameCountOffset,
    true,
  );
  const framesPointer = view.getUint32(
    base + FlowInvocationDescriptorLayout.framesPointerOffset,
    true,
  );
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    frames.push(
      readFrameDescriptor(
        memory,
        framesPointer + index * FlowFrameDescriptorLayout.size,
      ),
    );
  }
  return {
    nodeIndex: view.getUint32(
      base + FlowInvocationDescriptorLayout.nodeIndexOffset,
      true,
    ),
    dispatchDescriptorIndex: view.getUint32(
      base + FlowInvocationDescriptorLayout.dispatchDescriptorIndexOffset,
      true,
    ),
    pluginIdPointer: view.getUint32(
      base + FlowInvocationDescriptorLayout.pluginIdPointerOffset,
      true,
    ),
    methodIdPointer: view.getUint32(
      base + FlowInvocationDescriptorLayout.methodIdPointerOffset,
      true,
    ),
    framesPointer,
    frameCount,
    pluginId: readCString(
      memory,
      view.getUint32(
        base + FlowInvocationDescriptorLayout.pluginIdPointerOffset,
        true,
      ),
    ),
    methodId: readCString(
      memory,
      view.getUint32(
        base + FlowInvocationDescriptorLayout.methodIdPointerOffset,
        true,
      ),
    ),
    frames,
  };
}

function withAllocatedFrame(bound, memory, frame, invoke) {
  const malloc = bound.resolvedByRole.mallocSymbol;
  const free = bound.resolvedByRole.freeSymbol;
  const pointer = Number(malloc(FlowFrameDescriptorLayout.size)) >>> 0;
  try {
    writeFrameDescriptor(memory, pointer, frame);
    return invoke(pointer);
  } finally {
    free(pointer);
  }
}

export async function bindCompiledInvocationAbi({
  artifact,
  instance = null,
  wasmExports = null,
  memory = null,
  requiredRoles = DefaultRequiredInvocationExportRoles,
} = {}) {
  const bound = await bindCompiledRuntimeAbi({
    artifact,
    instance,
    wasmExports,
    requiredRoles,
  });
  const resolvedMemory = resolveMemory(bound, memory);

  return {
    ...bound,
    memory: resolvedMemory,
    readCurrentInvocation() {
      const pointer =
        Number(bound.resolvedByRole.currentInvocationDescriptorSymbol()) >>> 0;
      return readInvocationDescriptor(resolvedMemory, pointer);
    },
    readIngressFrameDescriptors() {
      const pointer =
        Number(bound.resolvedByRole.ingressFrameDescriptorsSymbol()) >>> 0;
      const count = Number(
        bound.resolvedByRole.ingressFrameDescriptorCountSymbol(),
      );
      const frames = [];
      for (let index = 0; index < count; index += 1) {
        frames.push(
          readFrameDescriptor(
            resolvedMemory,
            pointer + index * FlowFrameDescriptorLayout.size,
          ),
        );
      }
      return frames;
    },
    prepareNodeInvocationDescriptor(nodeIndex, frameBudget = 1) {
      bound.resolvedByRole.prepareInvocationDescriptorSymbol(
        nodeIndex,
        frameBudget,
      );
      return this.readCurrentInvocation();
    },
    enqueueTriggerFrame(triggerIndex, frame) {
      return withAllocatedFrame(bound, resolvedMemory, frame, (pointer) =>
        bound.resolvedByRole.enqueueTriggerFrameSymbol(triggerIndex, pointer),
      );
    },
    enqueueEdgeFrame(edgeIndex, frame) {
      return withAllocatedFrame(bound, resolvedMemory, frame, (pointer) =>
        bound.resolvedByRole.enqueueEdgeFrameSymbol(edgeIndex, pointer),
      );
    },
  };
}

export default bindCompiledInvocationAbi;
