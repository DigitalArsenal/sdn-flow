import {
  BackpressurePolicy,
  DrainPolicy,
  NodeKind,
  TriggerKind,
  normalizeProgram,
} from "../runtime/index.js";

export function createSinglePluginFlow(options = {}) {
  const pluginId = String(options.pluginId ?? "").trim();
  const methodId = String(options.methodId ?? "").trim();
  if (!pluginId || !methodId) {
    throw new Error("createSinglePluginFlow requires pluginId and methodId.");
  }

  const nodeId = String(options.nodeId ?? "node-1").trim();
  const inputPortId = String(options.inputPortId ?? "in").trim();
  const triggerId = options.trigger ? String(options.trigger.triggerId ?? "trigger-1").trim() : null;

  return normalizeProgram({
    programId: options.programId ?? `${pluginId}.${methodId}`,
    name: options.name ?? `${pluginId}:${methodId}`,
    version: options.version ?? "0.1.0",
    nodes: [
      {
        nodeId,
        pluginId,
        methodId,
        kind: options.nodeKind ?? NodeKind.TRANSFORM,
        drainPolicy: options.drainPolicy ?? DrainPolicy.DRAIN_UNTIL_YIELD,
        timeSliceMicros: options.timeSliceMicros ?? 1000,
      },
    ],
    edges: Array.isArray(options.edges) ? options.edges : [],
    triggers: triggerId
      ? [
          {
            triggerId,
            kind: options.trigger.kind ?? TriggerKind.MANUAL,
            source: options.trigger.source ?? null,
            protocolId: options.trigger.protocolId ?? null,
            defaultIntervalMs: options.trigger.defaultIntervalMs ?? 0,
            acceptedTypes: options.trigger.acceptedTypes ?? [],
            description: options.trigger.description ?? null,
          },
        ]
      : [],
    triggerBindings: triggerId
      ? [
          {
            triggerId,
            targetNodeId: nodeId,
            targetPortId: inputPortId,
            backpressurePolicy:
              options.trigger.backpressurePolicy ?? BackpressurePolicy.QUEUE,
            queueDepth: options.trigger.queueDepth ?? 1,
          },
        ]
      : [],
    requiredPlugins: [pluginId],
    description:
      options.description ??
      "Single-plugin flow. A single plugin is modeled as a one-node flow.",
  });
}

export class FlowDesignerSession {
  #program;

  constructor(options = {}) {
    this.#program = normalizeProgram(options.program ?? {});
  }

  static fromSinglePlugin(options = {}) {
    return new FlowDesignerSession({
      program: createSinglePluginFlow(options),
    });
  }

  loadProgram(program) {
    this.#program = normalizeProgram(program);
    return this.#program;
  }

  snapshot() {
    return normalizeProgram(this.#program);
  }

  addNode(node) {
    const program = this.snapshot();
    program.nodes.push(node);
    this.#program = normalizeProgram(program);
    return this.#program;
  }

  addEdge(edge) {
    const program = this.snapshot();
    program.edges.push(edge);
    this.#program = normalizeProgram(program);
    return this.#program;
  }

  addTrigger(trigger, binding = null) {
    const program = this.snapshot();
    program.triggers.push(trigger);
    if (binding) {
      program.triggerBindings.push(binding);
    }
    this.#program = normalizeProgram(program);
    return this.#program;
  }

  async compile({ compiler, target = null, metadata = null } = {}) {
    if (!compiler || typeof compiler.compile !== "function") {
      throw new Error("FlowDesignerSession.compile requires a compiler adapter.");
    }
    return compiler.compile({
      program: this.snapshot(),
      target,
      metadata,
    });
  }

  async deploy({
    compiler,
    deploymentClient,
    target,
    signer,
    recipientPublicKey = null,
    requiredCapabilities = null,
    metadata = null,
  } = {}) {
    if (!deploymentClient || typeof deploymentClient.deploy !== "function") {
      throw new Error(
        "FlowDesignerSession.deploy requires a deployment client.",
      );
    }
    const artifact = await this.compile({ compiler, target, metadata });
    return deploymentClient.deploy({
      artifact,
      target,
      signer,
      recipientPublicKey,
      requiredCapabilities,
    });
  }
}

export default FlowDesignerSession;
