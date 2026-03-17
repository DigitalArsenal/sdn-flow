# Plugin Architecture

## Scope

This document defines how `sdn-flow` consumes the standalone plugin
architecture sourced from `space-data-module-sdk`.

It covers:

- plugin identity and manifest rules
- streaming method contracts
- external interface declarations
- callable manifest exports
- the relationship between plugins and flows
- local and remote deployment expectations

## Core Rule

The runtime does not distinguish between "a plugin" and "a flow" at deployment
time. A single plugin invocation is a one-node flow.

That means:

- single-plugin execution uses the same deploy model as multi-node graphs
- compiled deployment is always one WASM runtime artifact
- trigger, queueing, and drain semantics stay uniform

## Plugin Contract

Every plugin participates in the flow system through a manifest-defined method
surface.

A method declares:

- stable `methodId`
- one or more input ports
- zero or more output ports
- accepted schema sets per port
- stream-count limits
- `maxBatch`
- `drainPolicy`

Methods are invoked over schema-tagged frame streams, not ad hoc JSON payloads.

Plugins may also declare `externalInterfaces` so visual editors and deployment
tooling can show the real network, protocol, filesystem, database, or host
service bindings required to make the graph run.

Keep capability IDs coarse and portable. Use interface metadata to capture
runtime-specific details such as:

- HTTP method sets
- TCP/UDP/raw-socket transport mode
- filesystem sandbox or mount location
- pipe or stream direction
- IPFS or SDS service operation

Storage engines follow the same rule. A FlatSQL database should be represented
as a storage plugin/runtime that:

- ingests aligned FlatBuffer records
- exposes query methods
- declares whether it is backed by transient memory or a host-provided storage
  adapter

The host should not hide a second engine-owned SQL source of truth behind that
plugin surface.

Infrastructure libraries follow the same rule. If a deployable flow depends on
`hd-wallet-wasm`, DA FlatBuffers, or similar runtime libraries for signing,
envelope encryption, field-level encryption, schema transforms, or repacking,
those surfaces should appear as normal manifest-defined plugins. Do not hide
them behind host-only helper code.

For the canonical host capability rules and environment profiles, see:

- [Host Capability Model](./HOST_CAPABILITY_MODEL.md)

## Manifest Rule

Every plugin must embed a FlatBuffer manifest buffer and expose callable exports
for it.

Default export names:

- `plugin_get_manifest_flatbuffer`
- `plugin_get_manifest_flatbuffer_size`

Compiled flow artifacts follow the same rule with flow-scoped export names:

- `flow_get_manifest_flatbuffer`
- `flow_get_manifest_flatbuffer_size`

The manifest is part of the runtime contract. Sidecar metadata files are not
sufficient for deployable artifacts.

## Streaming Model

Each input port accepts one or more streams of schema-tagged frames.

Each frame carries runtime type identity:

- `schemaName`
- `fileIdentifier`
- optional `schemaHash`
- `streamId`
- `sequence`
- `traceId`

If a method only processes one frame per invocation, the runtime keeps invoking
it until the backlog is drained or the scheduler yields.

## Plugin Families

`sdn-flow` does not hardcode host-specific plugin classes. Common families
include:

- propagators
- sensors
- analyzers
- publishers
- responders
- infrastructure plugins

Examples of infrastructure plugins include FlatSQL storage, `hd-wallet-wasm`
sign/encrypt nodes, and DA FlatBuffers schema/field transform nodes.

All of them enter the runtime through the same manifest + method contract.

## Host Boundary

Hosts are responsible for:

- manifest decoding
- plugin loading and registration
- capability enforcement
- editor integration for external interface inspection and approval
- compilation of flow graphs into deployable WASM artifacts
- installation and execution of those artifacts

`sdn-flow` owns the portable runtime and deployment model, not host-specific
loading code.

Host-specific runtime differences must stay in capability bindings and hosted
runtime plans. They must not fork the plugin ABI.
