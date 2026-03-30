import { startStandaloneFlowRuntime } from "./standaloneRuntime.js";

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array();
}

function normalizeTriggerFrame(frame = {}, index = 0) {
  return {
    typeDescriptorIndex: Number(frame.typeDescriptorIndex ?? 0) >>> 0,
    alignment: Math.max(1, Number(frame.alignment ?? 8) || 8),
    bytes: toUint8Array(frame.bytes ?? frame.payload ?? null),
    streamId: Number(frame.streamId ?? 1) >>> 0,
    sequence: Number(frame.sequence ?? index + 1) >>> 0,
    traceToken: Number(frame.traceToken ?? index + 1) >>> 0,
    endOfStream: frame.endOfStream === true,
  };
}

export async function createStandaloneFlowHarness(options = {}) {
  const runtime = await startStandaloneFlowRuntime(options);

  return {
    runtime,
    artifact: runtime.artifact,
    target: runtime.target,
    runtimeTargets: runtime.runtimeTargets,

    async runTriggerFrames(
      frames = [],
      {
        triggerIndex = 0,
        frameBudget = 1,
        outputStreamCap = 16,
        maxIterations = 1024,
      } = {},
    ) {
      let enqueued = 0;
      frames.forEach((frame, index) => {
        enqueued += runtime.enqueueTriggerFrame(
          triggerIndex,
          normalizeTriggerFrame(frame, index),
        );
      });
      const drainResult = await runtime.drainWithHostDispatch({
        frameBudget,
        outputStreamCap,
        maxIterations,
      });
      return {
        ...drainResult,
        enqueued,
      };
    },

    async runTriggerFrame(frame, options = {}) {
      return this.runTriggerFrames([frame], options);
    },

    async close() {
      await runtime.close();
    },
  };
}
