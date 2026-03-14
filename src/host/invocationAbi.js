import {
  bindCompiledRuntimeAbi,
  DefaultRequiredRuntimeExportRoles,
} from "./runtimeAbi.js";
import {
  FlowFrameDescriptorLayout,
  FlowInvocationDescriptorLayout,
} from "../generated/runtimeAbiLayouts.js";

export { FlowFrameDescriptorLayout, FlowInvocationDescriptorLayout };

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
  "applyInvocationResultSymbol",
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

function writeCString(memory, pointer, value) {
  const bytes = new Uint8Array(memory.buffer);
  const encoded = new TextEncoder().encode(`${String(value ?? "")}\0`);
  bytes.set(encoded, pointer >>> 0);
}

function cloneBytes(memory, offset, size) {
  const base = Number(offset) >>> 0;
  const length = Number(size) >>> 0;
  if (length === 0) {
    return new Uint8Array();
  }
  const bytes = new Uint8Array(memory.buffer, base, length);
  return new Uint8Array(bytes);
}

function readFrameDescriptor(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  return {
    ingressIndex: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.ingressIndex.offset,
      true,
    ),
    typeDescriptorIndex: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.typeDescriptorIndex.offset,
      true,
    ),
    portIdPointer: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.portIdPointer.offset,
      true,
    ),
    portId: readCString(
      memory,
      view.getUint32(base + FlowFrameDescriptorLayout.fields.portIdPointer.offset, true),
    ),
    alignment: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.alignment.offset,
      true,
    ),
    offset: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.offset.offset,
      true,
    ),
    size: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.size.offset,
      true,
    ),
    streamId: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.streamId.offset,
      true,
    ),
    sequence: view.getUint32(
      base + FlowFrameDescriptorLayout.fields.sequence.offset,
      true,
    ),
    traceToken: Number(
      view.getBigUint64(
        base + FlowFrameDescriptorLayout.fields.traceToken.offset,
        true,
      ),
    ),
    endOfStream:
      view.getUint8(base + FlowFrameDescriptorLayout.fields.endOfStream.offset) !==
      0,
    occupied:
      view.getUint8(base + FlowFrameDescriptorLayout.fields.occupied.offset) !== 0,
  };
}

function allocateCString(bound, memory, value) {
  if (value === null || value === undefined) {
    return 0;
  }
  const encoded = new TextEncoder().encode(`${String(value)}\0`);
  const pointer = Number(bound.resolvedByRole.mallocSymbol(encoded.length)) >>> 0;
  writeCString(memory, pointer, value);
  return pointer;
}

function writeFrameDescriptor(memory, pointer, frame = {}, portIdPointer = 0) {
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.ingressIndex.offset,
    Number(frame.ingressIndex ?? frame.ingress_index ?? INVALID_INDEX) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.typeDescriptorIndex.offset,
    Number(
      frame.typeDescriptorIndex ?? frame.type_descriptor_index ?? INVALID_INDEX,
    ) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.portIdPointer.offset,
    Number(portIdPointer) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.alignment.offset,
    Number(frame.alignment ?? 8) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.offset.offset,
    Number(frame.offset ?? 0) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.size.offset,
    Number(frame.size ?? 0) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.streamId.offset,
    Number(frame.streamId ?? frame.stream_id ?? 0) >>> 0,
    true,
  );
  view.setUint32(
    base + FlowFrameDescriptorLayout.fields.sequence.offset,
    Number(frame.sequence ?? 0) >>> 0,
    true,
  );
  view.setBigUint64(
    base + FlowFrameDescriptorLayout.fields.traceToken.offset,
    BigInt(Number(frame.traceToken ?? frame.trace_token ?? 0)),
    true,
  );
  view.setUint8(
    base + FlowFrameDescriptorLayout.fields.endOfStream.offset,
    (frame.endOfStream ?? frame.end_of_stream) ? 1 : 0,
  );
  view.setUint8(base + FlowFrameDescriptorLayout.fields.occupied.offset, 1);
}

function readInvocationDescriptor(memory, pointer) {
  if (!pointer) {
    return null;
  }
  const view = new DataView(memory.buffer);
  const base = pointer >>> 0;
  const frameCount = view.getUint32(
    base + FlowInvocationDescriptorLayout.fields.frameCount.offset,
    true,
  );
  const framesPointer = view.getUint32(
    base + FlowInvocationDescriptorLayout.fields.framesPointer.offset,
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
      base + FlowInvocationDescriptorLayout.fields.nodeIndex.offset,
      true,
    ),
    dispatchDescriptorIndex: view.getUint32(
      base + FlowInvocationDescriptorLayout.fields.dispatchDescriptorIndex.offset,
      true,
    ),
    pluginIdPointer: view.getUint32(
      base + FlowInvocationDescriptorLayout.fields.pluginIdPointer.offset,
      true,
    ),
    methodIdPointer: view.getUint32(
      base + FlowInvocationDescriptorLayout.fields.methodIdPointer.offset,
      true,
    ),
    framesPointer,
    frameCount,
    pluginId: readCString(
      memory,
      view.getUint32(
        base + FlowInvocationDescriptorLayout.fields.pluginIdPointer.offset,
        true,
      ),
    ),
    methodId: readCString(
      memory,
      view.getUint32(
        base + FlowInvocationDescriptorLayout.fields.methodIdPointer.offset,
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
  const portIdPointer = allocateCString(
    bound,
    memory,
    frame.portId ?? frame.port_id ?? null,
  );
  try {
    writeFrameDescriptor(memory, pointer, frame, portIdPointer);
    return invoke(pointer);
  } finally {
    if (portIdPointer) {
      free(portIdPointer);
    }
    free(pointer);
  }
}

function withAllocatedFrames(bound, memory, frames = [], invoke) {
  const normalizedFrames = Array.isArray(frames) ? frames : [];
  if (normalizedFrames.length === 0) {
    return invoke(0, 0);
  }
  const malloc = bound.resolvedByRole.mallocSymbol;
  const free = bound.resolvedByRole.freeSymbol;
  const descriptorBytes = FlowFrameDescriptorLayout.size * normalizedFrames.length;
  const descriptorsPointer = Number(malloc(descriptorBytes)) >>> 0;
  const portIdPointers = [];
  const payloadPointers = [];
  try {
    normalizedFrames.forEach((frame, index) => {
      const portIdPointer = allocateCString(
        bound,
        memory,
        frame.portId ?? frame.port_id ?? null,
      );
      portIdPointers.push(portIdPointer);
      const payload =
        frame.bytes ??
        frame.data ??
        frame.payloadBytes ??
        frame.payload_bytes ??
        null;
      let payloadPointer = Number(frame.offset ?? 0) >>> 0;
      let payloadSize = Number(frame.size ?? 0) >>> 0;
      if (payload instanceof Uint8Array || ArrayBuffer.isView(payload) || payload instanceof ArrayBuffer) {
        const payloadBytes = payload instanceof Uint8Array
          ? payload
          : payload instanceof ArrayBuffer
            ? new Uint8Array(payload)
            : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        payloadPointer = Number(malloc(payloadBytes.byteLength || 1)) >>> 0;
        payloadSize = payloadBytes.byteLength;
        new Uint8Array(memory.buffer).set(payloadBytes, payloadPointer);
        payloadPointers.push(payloadPointer);
      }
      writeFrameDescriptor(
        memory,
        descriptorsPointer + index * FlowFrameDescriptorLayout.size,
        {
          ...frame,
          offset: payloadPointer,
          size: payloadSize,
        },
        portIdPointer,
      );
    });
    return invoke(descriptorsPointer, normalizedFrames.length);
  } finally {
    portIdPointers.forEach((pointer) => {
      if (pointer) {
        free(pointer);
      }
    });
    // Descriptor memory is only needed for the duration of the host call.
    free(descriptorsPointer);
    // Payload memory is retained by the compiled runtime until reset; caller is
    // expected to release tracked allocations through the bound host helpers.
    payloadPointers.forEach((pointer) => {
      if (pointer) {
        bound.retainedArenaAllocations.add(pointer);
      }
    });
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
  bound.retainedArenaAllocations = new Set();

  return {
    ...bound,
    memory: resolvedMemory,
    retainedArenaAllocations: bound.retainedArenaAllocations,
    releaseRetainedArenaAllocations() {
      const free = bound.resolvedByRole.freeSymbol;
      for (const pointer of this.retainedArenaAllocations) {
        free(pointer);
      }
      this.retainedArenaAllocations.clear();
    },
    readFrameBytes(frame) {
      if (!frame) {
        return new Uint8Array();
      }
      return cloneBytes(
        resolvedMemory,
        frame.offset ?? frame.offset_bytes ?? 0,
        frame.size ?? 0,
      );
    },
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
    applyNodeInvocationResult(nodeIndex, result = {}) {
      return withAllocatedFrames(
        bound,
        resolvedMemory,
        result.outputs ?? [],
        (pointer, count) =>
          bound.resolvedByRole.applyInvocationResultSymbol(
            nodeIndex,
            Number(result.statusCode ?? result.status_code ?? 0) >>> 0,
            Number(result.backlogRemaining ?? result.backlog_remaining ?? 0) >>> 0,
            Boolean(result.yielded ?? false),
            pointer,
            count,
          ),
      );
    },
    resetRuntimeState() {
      bound.resolvedByRole.resetStateSymbol();
      this.releaseRetainedArenaAllocations();
    },
  };
}

export default bindCompiledInvocationAbi;
