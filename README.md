# sdn-flow

`@digitalarsenal/sdn-flow` is a standalone flow-runtime and deployment toolkit
for schema-driven WASM systems.

It provides the portable pieces needed to:

- model work as typed flow graphs
- treat a single plugin as a valid one-node flow
- execute flows locally in an isomorphic runtime
- compile deployable flows into one WASM runtime artifact
- require embedded FlatBuffer manifests in plugins and compiled flows
- authorize deployment with HD-wallet signatures
- encrypt deployment payloads in transit with PKI

## Core Model

The project is built around a small set of hard rules:

- Deployment is always a compiled WASM runtime artifact, never a raw graph.
- A single plugin is just a degenerate flow, not a separate deployment path.
- Every deployable artifact must embed a FlatBuffer manifest and expose
  callable manifest export symbols.
- Local and remote deployment use the same signed artifact envelope.
- Transport encryption protects the deployment package, not the runtime model.

## What The Package Provides

- `runtime`: normalized manifests, method registry, queueing, and flow
  execution
- `designer`: UI-facing flow session and single-plugin flow creation helpers
- `auth`: canonical deployment authorization payloads and HD-wallet signature
  helpers
- `transport`: PKI-based encrypted transport envelopes
- `deploy`: compiled artifact normalization and local/remote deployment client

## What The Package Does Not Do

- It does not define your host-specific schemas.
- It does not compile WASM by itself.
- It does not assume a specific host application or server runtime.
- It does not ship host adapters for installation, persistence, or execution.

Those pieces are intentionally left to the host that consumes this package.

## Compiler Contract

`sdn-flow` expects a compiler adapter that turns a validated flow program into a
deployable artifact:

```js
const artifact = await compiler.compile({
  program,
  target,
  metadata,
});
```

The artifact must include:

- compiled WASM bytes
- embedded FlatBuffer manifest bytes
- callable manifest export symbol names
- graph and manifest identity metadata

The deploy client only ships the compiled artifact. It does not deploy the raw
source graph.

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
- `@digitalarsenal/sdn-flow/auth`
- `@digitalarsenal/sdn-flow/transport`
- `@digitalarsenal/sdn-flow/deploy`

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Plugin Architecture](./docs/PLUGIN_ARCHITECTURE.md)
- [Plugin Manifest](./docs/PLUGIN_MANIFEST.md)
- [Compatibility Model](./docs/PLUGIN_COMPATIBILITY.md)

## Examples

- [Basic Propagator Plugin](./examples/plugins/basic-propagator/README.md)
- [Basic Sensor Plugin](./examples/plugins/basic-sensor/README.md)
- [Single-Plugin Flow](./examples/flows/single-plugin-flow.json)

## Status

The current repo contains the portable runtime, designer controller,
authorization helpers, transport encryption helpers, and deployment client.
