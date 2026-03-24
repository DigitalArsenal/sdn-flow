import { BackpressurePolicy, DrainPolicy } from "./constants.js";
import { normalizeFrame, normalizeProgram } from "./normalize.js";

// Temporary migration harness used for authoring/tests until the generated C++
// runtime is the only execution path.

function groupBy(items, keySelector) {
  const grouped = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keySelector(item);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }
  return grouped;
}

export class FlowRuntime {
  #registry;

  #program = null;

  #nodes = new Map();

  #triggerBindings = new Map();

  #edgesBySource = new Map();

  #maxInvocationsPerDrain;

  #onSinkOutput;

  constructor(options = {}) {
    this.#registry = options.registry;
    if (!this.#registry) {
      throw new Error("FlowRuntime requires a MethodRegistry instance.");
    }
    this.#maxInvocationsPerDrain = options.maxInvocationsPerDrain ?? 1024;
    this.#onSinkOutput = options.onSinkOutput ?? null;
  }

  loadProgram(program) {
    const normalized = normalizeProgram(program);
    this.#program = normalized;
    this.#nodes.clear();
    this.#triggerBindings = groupBy(
      normalized.triggerBindings,
      (binding) => binding.triggerId,
    );
    this.#edgesBySource = groupBy(
      normalized.edges,
      (edge) => `${edge.fromNodeId}:${edge.fromPortId}`,
    );

    for (const node of normalized.nodes) {
      this.#nodes.set(node.nodeId, {
        node,
        queues: new Map(),
        invocations: 0,
      });
    }

    return normalized;
  }

  getProgram() {
    return this.#program;
  }

  inspectQueues() {
    const snapshot = {};
    for (const [nodeId, state] of this.#nodes.entries()) {
      snapshot[nodeId] = {};
      for (const [portId, queue] of state.queues.entries()) {
        snapshot[nodeId][portId] = queue.length;
      }
    }
    return snapshot;
  }

  enqueueTriggerFrames(triggerId, frames) {
    const bindings = this.#triggerBindings.get(triggerId) ?? [];
    if (bindings.length === 0) {
      throw new Error(`Trigger "${triggerId}" is not bound to any node input.`);
    }
    for (const binding of bindings) {
      this.enqueueNodeFrames(
        binding.targetNodeId,
        binding.targetPortId,
        frames,
        binding.backpressurePolicy,
        binding.queueDepth,
      );
    }
  }

  enqueueNodeFrames(
    nodeId,
    portId,
    frames,
    backpressurePolicy = BackpressurePolicy.QUEUE,
    queueDepth = 0,
  ) {
    const state = this.#nodes.get(nodeId);
    if (!state) {
      throw new Error(`Unknown node "${nodeId}".`);
    }
    const queue = state.queues.get(portId) ?? [];
    const normalizedFrames = Array.isArray(frames) ? frames : [frames];
    for (const frameInput of normalizedFrames) {
      const frame = Object.assign(normalizeFrame(frameInput), { portId });
      this.#applyBackpressure(queue, frame, backpressurePolicy, queueDepth);
    }
    state.queues.set(portId, queue);
  }

  async drain(options = {}) {
    const maxInvocations =
      options.maxInvocations ?? this.#maxInvocationsPerDrain;
    let invocations = 0;

    while (invocations < maxInvocations) {
      const readyState = this.#findReadyNodeState();
      if (!readyState) {
        break;
      }
      await this.#invokeNode(readyState);
      invocations += 1;
    }

    return {
      invocations,
      yielded: invocations >= maxInvocations,
      idle: this.isIdle(),
    };
  }

  isIdle() {
    for (const state of this.#nodes.values()) {
      for (const queue of state.queues.values()) {
        if (queue.length > 0) {
          return false;
        }
      }
    }
    return true;
  }

  #findReadyNodeState() {
    if (!this.#program) {
      throw new Error("FlowRuntime has no loaded program.");
    }
    for (const node of this.#program.nodes) {
      const state = this.#nodes.get(node.nodeId);
      const descriptor = this.#registry.getMethod(node.pluginId, node.methodId);
      if (!state || !descriptor) {
        continue;
      }
      let ready = false;
      let missingRequiredPort = false;
      for (const port of descriptor.method.inputPorts) {
        const queue = state.queues.get(port.portId) ?? [];
        if (port.required && queue.length === 0) {
          missingRequiredPort = true;
          break;
        }
        if (queue.length > 0) {
          ready = true;
        }
      }
      if (!missingRequiredPort && ready) {
        return state;
      }
    }
    return null;
  }

  async #invokeNode(state) {
    const descriptor = this.#registry.getMethod(
      state.node.pluginId,
      state.node.methodId,
    );
    const maxBatch = Math.max(1, descriptor.method.maxBatch ?? 1);
    const inputs = [];
    for (const port of descriptor.method.inputPorts) {
      const queue = state.queues.get(port.portId) ?? [];
      const takeCount = Math.min(queue.length, maxBatch);
      for (let index = 0; index < takeCount; index += 1) {
        inputs.push(queue.shift());
      }
      state.queues.set(port.portId, queue);
    }

    const drainPolicy =
      state.node.drainPolicy ??
      descriptor.method.drainPolicy ??
      DrainPolicy.DRAIN_UNTIL_YIELD;
    const response = await this.#registry.invoke({
      pluginId: state.node.pluginId,
      methodId: state.node.methodId,
      inputs,
      outputStreamCap: 0,
      drainPolicy,
      context: {
        nodeId: state.node.nodeId,
        programId: this.#program.programId,
        internalTransport: true,
      },
    });

    state.invocations += 1;
    this.#routeOutputs(state.node.nodeId, response.outputs ?? []);
  }

  #routeOutputs(nodeId, outputs) {
    for (const frame of outputs) {
      const sourceKey = `${nodeId}:${frame.portId}`;
      const edges = this.#edgesBySource.get(sourceKey) ?? [];
      if (edges.length === 0) {
        if (typeof this.#onSinkOutput === "function") {
          this.#onSinkOutput({ nodeId, frame });
        }
        continue;
      }
      for (const edge of edges) {
        this.enqueueNodeFrames(
          edge.toNodeId,
          edge.toPortId,
          [frame],
          edge.backpressurePolicy,
          edge.queueDepth,
        );
      }
    }
  }

  #applyBackpressure(queue, frame, policy, queueDepth) {
    const cap = Number(queueDepth ?? 0);
    const bounded = cap > 0;
    switch (policy) {
      case BackpressurePolicy.DROP:
        if (!bounded || queue.length < cap) {
          queue.push(frame);
        }
        return;
      case BackpressurePolicy.LATEST:
      case BackpressurePolicy.COALESCE:
        if (!bounded || queue.length < cap) {
          queue.push(frame);
        } else {
          queue.splice(0, queue.length, frame);
        }
        return;
      case BackpressurePolicy.BLOCK_REQUEST:
        if (bounded && queue.length >= cap) {
          throw new Error("Backpressure queue is full.");
        }
        queue.push(frame);
        return;
      case BackpressurePolicy.DRAIN_TO_EMPTY:
      case BackpressurePolicy.QUEUE:
      default:
        if (bounded && queue.length >= cap) {
          queue.shift();
        }
        queue.push(frame);
    }
  }
}

export default FlowRuntime;
