# Architecture

## Package Boundary

`sdn-flow` is the portable layer between:

- UI flow authoring
- host-side runtime execution
- signed artifact dependency resolution
- generated C++ bundle compilation
- deployment authorization
- deployment transport

It is intentionally host-agnostic so different applications and runtimes can
consume the same contracts.

## Core Rule

A deployable flow is a compiled single WASM runtime artifact.

The source graph exists for authoring, validation, tracing, and compilation.
It is not the deployable unit.
There is no separate interpreted deployment engine.

## Single Plugin Rule

A single plugin invocation is modeled as a one-node flow with optional triggers
and zero or more sinks. There is no separate deployment path for "just a
plugin."

## Package Layers

### Runtime Contracts

The runtime layer defines normalized manifest/program objects used by authoring,
validation, and host integration:

- plugin manifests declare methods, ports, stream limits, and drain policies
- flow programs declare nodes, edges, triggers, and trigger bindings
- deployed execution lives in the generated C++ runtime, not in package JS

### Designer

The designer layer is UI-facing but DOM-free. It owns:

- graph mutation helpers
- external input/output and capability summaries for visual editors
- single-plugin flow creation
- compile orchestration through an injected compiler adapter
- deployment orchestration through an injected deployment client

### Host Planning

The host-planning layer owns portable hosted-runtime description:

- runtime kind (`flow`, `plugin`, `service`)
- startup phase (`bootstrap`, `early`, `session`, `on-demand`)
- local vs remote authority
- runtime dependencies
- transport bindings (`same-app`, `direct`, `webrtc`, `sdn-protocol`, `http`)

This keeps startup-only services such as local licensing in the same runtime
model as any other flow/plugin deployment.

### Compiler

The compiler layer owns:

- signed artifact catalog resolution
- single-source C++ runtime generation
- `emception`-compatible compile planning
- artifact assembly back into the deploy contract

### Authorization

Deployment permissions are explicit signed envelopes, designed for SDN HD-wallet
signatures.

The package defines:

- canonical payload encoding
- deploy authorization payload shape
- signer and verifier contracts
- scope checks against target, artifact, and required capabilities

### Transport

Remote deployment payloads may be encrypted with PKI. The transport layer
provides:

- X25519 ephemeral key agreement
- HKDF-derived AES-256-GCM content encryption
- JSON payload helpers for deployment envelopes

### Deploy

The deploy layer only ships compiled artifacts. It does not accept raw flow
graphs as the deployment boundary.

## Artifact Contract

A compiled flow artifact contains:

- `artifactId`
- `programId`
- `format`
- `wasm`
- `manifestBuffer`
- `manifestExports.bytesSymbol`
- `manifestExports.sizeSymbol`
- `entrypoint`
- `graphHash`
- `requiredCapabilities`
- `pluginVersions`
- `schemaBindings`
- `abiVersion`

The compile plan that produces that artifact may also include:

- generated `main.cpp`
- generated runtime topology descriptors and mutable node-state storage
- signed plugin artifact dependency descriptors
- signed plugin manifest bytes
- the exact `em++` command issued to `emception`

## Editor And Capability Model

Programs may declare:

- `externalInterfaces`
- `artifactDependencies`
- `editor` layout metadata

Plugin manifests may declare:

- `capabilities`
- `externalInterfaces`

The designer layer can merge those declarations with trigger bindings and
resolved plugin manifests so the operator can see:

- which network, timer, protocol, filesystem, and database bindings are needed
- which capabilities must be approved and signed
- which signed plugin artifacts must exist before compilation

## Host Integration

Hosts are expected to provide adapters for:

- graph validation against host capabilities
- manifest building into canonical FlatBuffer bytes
- compilation via `emception` or equivalent
- local deployment/install
- remote deployment endpoint verification and installation
- protocol/pubsub registration and network transport

Hosts may also use the portable host-planning surface to describe early-start
services, same-app loopback bindings, or WebRTC-connected local runtimes
without changing the flow/plugin ABI.

This package deliberately leaves those host integrations outside the portable
core.

## Manifest Rule

Every plugin and every compiled flow artifact must embed a FlatBuffer manifest
buffer and expose a callable export for it. The default flow export names are:

- `flow_get_manifest_flatbuffer`
- `flow_get_manifest_flatbuffer_size`

The default plugin export names are:

- `plugin_get_manifest_flatbuffer`
- `plugin_get_manifest_flatbuffer_size`

## Example

The repo includes a concrete example in
[examples/flows/iss-proximity-oem/flow.json](../examples/flows/iss-proximity-oem/flow.json)
that:

- streams OMMs from SDN pubsub
- ingests them into an in-memory FlatSQL database
- queries objects within `50 km` of object `25544`
- propagates `90` samples for one orbit
- generates OEMs
- writes and republishes those OEMs through explicit sink nodes
