# sdn-flow

`@digitalarsenal/sdn-flow` is a standalone flow-runtime and deployment toolkit
for schema-driven WASM systems.

It provides the portable pieces needed to:

- model work as typed flow graphs
- treat a single plugin as a valid one-node flow
- treat storage engines such as FlatSQL as first-class plugins instead of
  hidden host subsystems
- summarize external inputs, outputs, and capabilities for visual editors
- describe hosted runtime startup phases and local/remote transport bindings
- compile deployable flows into one authoritative C++/WASM runtime artifact
- generate that C++ source with a native C++ tool compiled to WASM
- compile from one generated C++ source file through `../emception`
- consume signed plugin WASM artifacts as build dependencies instead of plugin source
- require embedded FlatBuffer manifests in plugins and compiled flows
- authorize deployment with HD-wallet signatures
- encrypt deployment payloads in transit with PKI

## Core Model

The project is built around a small set of hard rules:

- Deployment is always a compiled WASM runtime artifact, never a raw graph.
- A single plugin is just a degenerate flow, not a separate deployment path.
- Hosts may run multiple runtimes. Startup-only services such as licensing are
  just runtimes with earlier startup phases and different bindings.
- The deployed runtime is generated C++ compiled through `../emception`. There
  is no separate interpreted deployment engine.
- The C++ flow source generator is itself a native C++ tool compiled to WASM.
- The JS compiler surface is limited to request marshaling and invoking the
  generator/compile toolchain.
- Every deployable artifact must embed a FlatBuffer manifest and expose
  callable manifest export symbols.
- Local and remote deployment use the same signed artifact envelope.
- Transport encryption protects the deployment package, not the runtime model.
- Host capability differences are explicit and documented per environment
  profile; they do not create a second plugin ABI.

## What The Package Provides

- `runtime`: normalized manifests, method registries, and topology contracts
  used by authoring, validation, and host integration
- `designer`: UI-facing flow session, single-plugin flow creation helpers, and
  external-requirement summaries
- `host`: portable hosted-runtime planning for startup order, local services,
  and same-app/WebRTC/SDN transport bindings
- `auth`: canonical deployment authorization payloads and HD-wallet signature
  helpers
- `transport`: PKI-based encrypted transport envelopes
- `deploy`: compiled artifact normalization and local/remote deployment client
- `compiler`: signed-artifact catalog, native-WASM source generator, generated
  C++ source, and `emception` compiler adapter

## What The Package Does Not Do

- It does not define your host-specific schemas.
- It does not assume a specific host application or server runtime.
- It does not ship host adapters for installation, persistence, or execution.

Those pieces are intentionally left to the host that consumes this package.
What `sdn-flow` does provide is a portable way to describe those runtime
relationships so browser, desktop, and server hosts can stay isomorphic.

## Compiler Contract

`sdn-flow` expects a compiler adapter that turns a validated flow program into a
deployable artifact. The built-in `EmceptionCompilerAdapter` generates one C++
translation unit that embeds the flow manifest bytes and the signed plugin
artifact bytes, then hands that source to an `emception`-compatible compiler:

```js
const compiler = new EmceptionCompilerAdapter({
  emception,
  artifactCatalog,
  manifestBuilder,
});

const artifact = await compiler.compile({
  program,
});
```

The artifact must include:

- compiled WASM bytes
- embedded FlatBuffer manifest bytes
- callable manifest export symbol names
- graph and manifest identity metadata

The deploy client only ships the compiled artifact. It does not deploy the raw
source graph.

The built-in source generator no longer renders `main.cpp` in JavaScript. It
packages a normalized request, invokes a native C++ generator compiled to WASM,
and feeds the resulting C++ translation unit into the compile adapter.

## Visual Editor Contract

The designer session can also summarize everything a flow needs from the host:

```js
const summary = session.inspectRequirements({
  manifests,
  registry,
});
```

That summary includes:

- external inputs and outputs
- required capabilities
- signed artifact dependencies
- resolved plugin manifests when available

## Hosted Runtime Planning

Hosts can describe how runtimes start and connect without changing the core
flow/plugin contract:

```js
import { summarizeHostedRuntimePlan } from "@digitalarsenal/sdn-flow";

const summary = summarizeHostedRuntimePlan({
  hostId: "orbpro-browser",
  hostKind: "orbpro",
  adapter: "sdn-js",
  runtimes: [
    {
      runtimeId: "license-service",
      kind: "service",
      programId: "com.orbpro.license.local",
      startupPhase: "early",
      autoStart: true,
      bindings: [
        {
          direction: "listen",
          transport: "same-app",
          protocolId: "/orbpro/licensing/1.0.0",
        },
      ],
    },
  ],
});
```

## Deployment Flow

The package uses one deployment model for both local and remote targets:

1. Build or load the flow program.
2. Compile it into one WASM runtime artifact.
3. Create a deployment authorization envelope.
4. Sign the authorization with an HD-wallet key.
5. Optionally encrypt the deployment package for the recipient.
6. Send the compiled artifact package to the target.

## Manifest Rule

Every plugin and every compiled flow artifact must embed a FlatBuffer manifest
buffer and expose callable exports for it.

Default export names:

- `plugin_get_manifest_flatbuffer`
- `plugin_get_manifest_flatbuffer_size`
- `flow_get_manifest_flatbuffer`
- `flow_get_manifest_flatbuffer_size`

## Package Surface

- `@digitalarsenal/sdn-flow`
- `@digitalarsenal/sdn-flow/runtime`
- `@digitalarsenal/sdn-flow/designer`
- `@digitalarsenal/sdn-flow/host`
- `@digitalarsenal/sdn-flow/auth`
- `@digitalarsenal/sdn-flow/transport`
- `@digitalarsenal/sdn-flow/deploy`
- `@digitalarsenal/sdn-flow/compiler`

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Host Capability Model](./docs/HOST_CAPABILITY_MODEL.md)
- [Plugin Architecture](./docs/PLUGIN_ARCHITECTURE.md)
- [Plugin Manifest](./docs/PLUGIN_MANIFEST.md)
- [Compatibility Model](./docs/PLUGIN_COMPATIBILITY.md)

## Examples

- [Environment Demos](./examples/environments/README.md)
- [Basic Propagator Plugin](./examples/plugins/basic-propagator/README.md)
- [Basic Sensor Plugin](./examples/plugins/basic-sensor/README.md)
- [FlatSQL Storage Plugin](./examples/plugins/flatsql-store/README.md)
- [HD Wallet Crypto Plugin](./examples/plugins/hd-wallet-crypto/README.md)
- [DA FlatBuffers Codec Plugin](./examples/plugins/da-flatbuffers-codec/README.md)
- [Single-Plugin Flow](./examples/flows/single-plugin-flow.json)
- [Field-Protected Catalog Entry Flow](./examples/flows/field-protected-catalog-entry/README.md)
- [ISS Proximity OEM Flow](./examples/flows/iss-proximity-oem/README.md)

## Status

The current repo contains the portable graph/manifest contracts, designer
controller, authorization helpers, transport encryption helpers, deployment
client, a native-WASM C++ source generator, and a portable `emception`
compiler adapter for single-bundle C++ runtime builds.
