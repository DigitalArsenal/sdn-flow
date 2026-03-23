import {
  assertDeploymentAuthorization,
  createDeploymentAuthorization,
  signAuthorization,
} from "../auth/index.js";
import { normalizeDeploymentPlan } from "space-data-module-sdk";
import { evaluateHostedRuntimeTargetSupport } from "../host/profile.js";
import { encryptJsonForRecipient } from "../transport/index.js";
import {
  listCompiledArtifactRuntimeTargets,
  normalizeCompiledArtifact,
  serializeCompiledArtifact,
} from "./compiledArtifact.js";

function normalizeString(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => normalizeString(value, null))
        .filter(Boolean),
    ),
  ).sort();
}

function serializeTarget(target = null) {
  if (typeof target === "string") {
    return {
      kind: "remote",
      id: null,
      audience: null,
      url: target,
      runtimeId: null,
      transport: null,
      protocolId: null,
      peerId: null,
      startupPhase: null,
      adapter: null,
      hostKind: null,
      engine: null,
      runtimeTargets: [],
      disconnected: false,
    };
  }
  return {
    kind: target?.kind ?? "remote",
    id: target?.id ?? target?.targetId ?? target?.runtimeId ?? null,
    audience: target?.audience ?? null,
    url: target?.url ?? null,
    runtimeId: target?.runtimeId ?? target?.runtime_id ?? null,
    transport: target?.transport ?? null,
    protocolId: target?.protocolId ?? target?.protocol_id ?? null,
    peerId: target?.peerId ?? target?.peer_id ?? null,
    startupPhase: target?.startupPhase ?? target?.startup_phase ?? null,
    adapter: target?.adapter ?? target?.hostAdapter ?? null,
    hostKind: target?.hostKind ?? target?.host_kind ?? null,
    engine:
      target?.engine ?? target?.runtimeEngine ?? target?.runtime_engine ?? null,
    runtimeTargets: normalizeStringArray(
      target?.runtimeTargets ?? target?.runtime_targets,
    ),
    disconnected: Boolean(target?.disconnected ?? false),
  };
}

function assertDeploymentTargetCompatibility({
  artifact,
  targetDescriptor,
} = {}) {
  const requestedTargets = normalizeStringArray(
    listCompiledArtifactRuntimeTargets(artifact),
  );
  const runtimeTargets =
    requestedTargets.length > 0
      ? requestedTargets
      : normalizeStringArray(targetDescriptor?.runtimeTargets);
  const hasHostProfile = Boolean(
    normalizeString(targetDescriptor?.hostKind, null) ??
      normalizeString(targetDescriptor?.adapter, null) ??
      normalizeString(targetDescriptor?.engine, null),
  );
  if (!hasHostProfile || runtimeTargets.length === 0) {
    return;
  }

  const evaluation = evaluateHostedRuntimeTargetSupport({
    hostKind: targetDescriptor.hostKind,
    adapter: targetDescriptor.adapter,
    engine: targetDescriptor.engine,
    runtimeTargets,
  });
  if (evaluation.ok) {
    return;
  }

  throw new Error(
    `Deployment target cannot satisfy embedded runtimeTargets ${runtimeTargets.join(", ")} for host profile ${[
      evaluation.hostKind,
      evaluation.adapter,
      evaluation.engine,
    ]
      .filter(Boolean)
      .join("/")}. Unsupported targets: ${evaluation.unsupportedTargets.join(", ")}.`,
  );
}

export class FlowDeploymentClient {
  #fetch;

  #now;

  constructor(options = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch ?? null;
    this.#now = options.now ?? (() => Date.now());
  }

  async prepareDeployment({
    artifact,
    deploymentPlan = null,
    target,
    signer = null,
    requiredCapabilities = null,
    recipientPublicKey = null,
    authorization = null,
    encrypt = undefined,
  } = {}) {
    const requestedDeploymentPlan = deploymentPlan ?? artifact?.deploymentPlan ?? null;
    const normalizedArtifact = await normalizeCompiledArtifact(artifact);
    const targetDescriptor = serializeTarget(target);
    assertDeploymentTargetCompatibility({
      artifact: normalizedArtifact,
      targetDescriptor,
    });
    const capabilities =
      requiredCapabilities ?? normalizedArtifact.requiredCapabilities;
    const authorizationPayload =
      authorization ??
      await createDeploymentAuthorization({
        artifact: normalizedArtifact,
        target: targetDescriptor,
        capabilities,
        issuedAt: this.#now(),
      });
    const signedAuthorization = signer
      ? await signAuthorization({
          authorization: authorizationPayload,
          signer,
        })
      : null;

    if (signedAuthorization) {
      assertDeploymentAuthorization({
        envelope: signedAuthorization,
        artifact: normalizedArtifact,
        target: targetDescriptor,
        requiredCapabilities: capabilities,
        now: this.#now(),
      });
    }

    const payload = {
      version: 1,
      kind: "compiled-flow-wasm-deployment",
      artifact: serializeCompiledArtifact(normalizedArtifact),
      deploymentPlan: requestedDeploymentPlan
        ? normalizeDeploymentPlan(requestedDeploymentPlan)
        : null,
      authorization: signedAuthorization,
      target: targetDescriptor,
    };

    const shouldEncrypt =
      encrypt ?? Boolean(recipientPublicKey ?? target?.recipientPublicKey);
    if (shouldEncrypt) {
      return {
        version: 1,
        encrypted: true,
        envelope: await encryptJsonForRecipient({
          payload,
          recipientPublicKey: recipientPublicKey ?? target?.recipientPublicKey,
          context: `sdn-flow/deploy:${normalizedArtifact.programId}`,
        }),
      };
    }

    return {
      version: 1,
      encrypted: false,
      payload,
    };
  }

  async deployLocal({ target, deployment }) {
    if (!target || typeof target.deploy !== "function") {
      throw new Error("Local deployment target must expose deploy().");
    }
    return target.deploy(deployment);
  }

  async deployRemote({ target, deployment }) {
    if (!this.#fetch) {
      throw new Error("Remote deployment requires fetch.");
    }
    const url = typeof target === "string" ? target : target?.url;
    if (!url) {
      throw new Error("Remote deployment target must define url.");
    }
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(target?.headers ?? {}),
      },
      body: JSON.stringify(deployment),
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      const errorBody = contentType.includes("application/json")
        ? await response.json()
        : await response.text();
      throw new Error(
        `Remote deployment failed (${response.status}): ${JSON.stringify(errorBody)}`,
      );
    }
    return contentType.includes("application/json")
      ? response.json()
      : response.text();
  }

  async deploy(options = {}) {
    const deployment = await this.prepareDeployment(options);
    if (
      options.target?.kind === "local" ||
      typeof options.target?.deploy === "function"
    ) {
      return this.deployLocal({
        target: options.target,
        deployment,
      });
    }
    return this.deployRemote({
      target: options.target,
      deployment,
    });
  }
}

export default FlowDeploymentClient;
