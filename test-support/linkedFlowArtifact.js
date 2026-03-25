import { randomUUID } from "node:crypto";

import {
  cleanupCompilation,
  compileModuleFromSource,
  encodePluginManifest,
} from "space-data-module-sdk";

import {
  buildDefaultFlowManifestBuffer,
  createSdkEmceptionSession,
  EmceptionCompilerAdapter,
  SignedArtifactCatalog,
} from "../src/index.js";

function createLinkedTypeRef() {
  return {
    schemaName: "PluginManifest.fbs",
    fileIdentifier: "PMAN",
  };
}

export function createLinkedModuleManifest(overrides = {}) {
  const pluginId =
    overrides.pluginId ??
    `com.digitalarsenal.tests.linked-runtime.${randomUUID()}`;
  return {
    pluginId,
    name: "Linked Runtime Test Module",
    version: "0.1.0",
    pluginFamily: "analysis",
    capabilities: [],
    externalInterfaces: [],
    methods: [
      {
        methodId: "tick",
        displayName: "Tick",
        inputPorts: [
          {
            portId: "request",
            acceptedTypeSets: [
              {
                setId: "manifest",
                allowedTypes: [createLinkedTypeRef()],
              },
            ],
            minStreams: 1,
            maxStreams: 1,
            required: true,
          },
        ],
        outputPorts: [],
        maxBatch: 1,
        drainPolicy: "single-shot",
      },
    ],
    ...overrides,
  };
}

export function createLinkedFlowProgram({
  pluginId,
  version = "0.1.0",
  overrides = {},
} = {}) {
  const programId =
    overrides.programId ??
    `com.digitalarsenal.tests.linked-flow.${randomUUID()}`;
  return {
    programId,
    name: "Linked Flow Runtime",
    version: "0.1.0",
    nodes: [
      {
        nodeId: "linked-node",
        pluginId,
        methodId: "tick",
        kind: "method",
      },
    ],
    edges: [],
    triggers: [
      {
        triggerId: "manual-request",
        kind: "manual",
        acceptedTypes: [createLinkedTypeRef()],
      },
    ],
    triggerBindings: [
      {
        triggerId: "manual-request",
        targetNodeId: "linked-node",
        targetPortId: "request",
      },
    ],
    requiredPlugins: [pluginId],
    artifactDependencies: [
      {
        dependencyId: "dep-linked",
        pluginId,
        version,
      },
    ],
    ...overrides,
  };
}

export async function compileLinkedFlowArtifact({
  runtimeTargets = [],
  workingDirectory = `/working/linked-flow-${randomUUID()}`,
  manifestOverrides = {},
  programOverrides = {},
  sourceCode = "int tick(void) { return 0; }\n",
  language = "c",
} = {}) {
  const manifest = createLinkedModuleManifest(manifestOverrides);
  const moduleCompilation = await compileModuleFromSource({
    manifest,
    sourceCode,
    language,
  });

  try {
    const catalog = new SignedArtifactCatalog();
    catalog.registerArtifact({
      dependencyId: "dep-linked",
      pluginId: manifest.pluginId,
      version: manifest.version,
      signature: "sig",
      signerPublicKey: "pub",
      wasm: moduleCompilation.wasmBytes,
      manifestBuffer: encodePluginManifest(manifest),
      guestLink: moduleCompilation.guestLink,
    });

    const program = createLinkedFlowProgram({
      pluginId: manifest.pluginId,
      version: manifest.version,
      overrides: programOverrides,
    });
    const emception = await createSdkEmceptionSession({
      workingDirectory,
    });
    const compiler = new EmceptionCompilerAdapter({
      emception,
      artifactCatalog: catalog,
      manifestBuilder: async ({ program: flowProgram, dependencies }) =>
        buildDefaultFlowManifestBuffer({
          program: flowProgram,
          dependencies,
          runtimeTargets,
        }),
    });
    const artifact = await compiler.compile({ program });

    return {
      artifact,
      manifest,
      program,
    };
  } finally {
    await cleanupCompilation(moduleCompilation);
  }
}
