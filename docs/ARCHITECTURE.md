# Architecture

## Package Boundary

`sdn-flow` is the portable layer between:

- UI flow authoring
- host-side runtime execution
- deployment authorization
- deployment transport

It is intentionally separate from OrbPro and SDN host repos so both can consume
the same contracts.

## Core Rule

A deployable flow is a compiled single WASM runtime artifact.

The source graph exists for authoring, validation, tracing, and compilation.
It is not the deployable unit.

## Single Plugin Rule

A single plugin invocation is modeled as a one-node flow with optional triggers
and zero or more sinks. There is no separate deployment path for "just a
plugin."

## Package Layers

### Runtime

The runtime executes normalized manifest/program objects:

- plugin manifests declare methods, ports, stream limits, and drain policies
- flow programs declare nodes, edges, triggers, and trigger bindings
- execution is deterministic and single-threaded first

### Designer

The designer layer is UI-facing but DOM-free. It owns:

- graph mutation helpers
- single-plugin flow creation
- compile orchestration through an injected compiler adapter
- deployment orchestration through an injected deployment client

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

## Host Integration

Hosts are expected to provide adapters for:

- graph validation against host capabilities
- compilation via `emception` or equivalent
- local deployment/install
- remote deployment endpoint verification and installation

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
