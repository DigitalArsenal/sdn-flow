# Plugin Manifest

## Purpose

The manifest is the canonical description of a plugin's runtime contract.
Its schema and canonical validation rules are sourced from
`space-data-module-sdk`; this document explains how `sdn-flow` consumes that
module contract.

It should be treated as:

- machine-readable
- embeddable in compiled artifacts
- callable by hosts through manifest export functions
- stable enough to drive tooling, validation, and deployment

## Required Fields

A practical manifest should define at least:

- `pluginId`
- `name`
- `version`
- `pluginFamily`
- `methods`

Each method should define:

- `methodId`
- `inputPorts`
- `outputPorts`
- `maxBatch`
- `drainPolicy`

Each port should define:

- `portId`
- accepted schema sets
- `minStreams`
- `maxStreams`
- `required`

## Optional Fields

Depending on host needs, manifests may also declare:

- `capabilities`
- `externalInterfaces`
- `timers`
- `protocols`
- `schemasUsed`
- `buildArtifacts`

For storage plugins, manifests should also make backend selection explicit.
Typical patterns are:

- a logical database interface exposed to the flow
- a host-service storage-adapter interface that declares whether the plugin can
  run against memory, persistent host storage, or both

Capability guidance:

- keep capability IDs coarse and stable across hosts
- put runtime-specific transport details in `externalInterfaces[*].properties`
- use `externalInterfaces` to describe HTTP endpoints, TCP/UDP or raw-socket
  usage, filesystem paths, pipe/stream bindings, database surfaces, IPFS
  services, and SDS protocol bindings
- if a capability depends on a specific host profile, document that explicitly
  instead of implying generic-WASI portability

## Runtime Interpretation

The manifest is used to:

- register methods in the runtime
- validate input port shape and stream counts
- validate output routing
- determine capability requirements
- describe host bindings to visual editors and deployment tooling
- derive deployment metadata and compatibility views

## Embedded Manifest Rule

The manifest must be embedded as FlatBuffer bytes in deployable artifacts. Hosts
must be able to obtain the bytes directly from the artifact via callable
exports.

## Example

See:

- [Basic Propagator Plugin](../examples/plugins/basic-propagator/README.md)
- [Basic Sensor Plugin](../examples/plugins/basic-sensor/README.md)
- [Host Capability Model](./HOST_CAPABILITY_MODEL.md)
