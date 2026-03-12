# Plugin Architecture

## Scope

This document defines the standalone plugin architecture consumed by
`sdn-flow`.

It covers:

- plugin identity and manifest rules
- streaming method contracts
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

All of them enter the runtime through the same manifest + method contract.

## Host Boundary

Hosts are responsible for:

- manifest decoding
- plugin loading and registration
- capability enforcement
- compilation of flow graphs into deployable WASM artifacts
- installation and execution of those artifacts

`sdn-flow` owns the portable runtime and deployment model, not host-specific
loading code.
