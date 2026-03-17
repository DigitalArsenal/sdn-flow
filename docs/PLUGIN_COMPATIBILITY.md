# Compatibility Model

## Goal

`space-data-module-sdk` is the canonical module/plugin artifact model, and
`sdn-flow` is the canonical flow-composition model built on top of it.
Compatibility layers exist only to bridge older hosts and older metadata
formats into those models.

## What Stays Canonical

These remain canonical:

- typed manifest-driven methods from the shared module contract
- schema-tagged frame streams
- embedded FlatBuffer manifests
- compiled single-WASM flow deployment artifacts

## What Can Be Generated

Legacy compatibility surfaces may be generated from the canonical manifest, for
example:

- host-specific metadata JSON
- request-handler shims
- timer/cron wrappers
- protocol dispatch wrappers

Those artifacts are downstream views of the manifest, not alternate sources of
truth.

Compatibility wrappers must not become a shadow runtime model. In particular:

- do not describe a runtime as "portable WASI" unless its required imports and
  host bindings are actually portable
- do not let host-specific wrappers own business logic that should live in the
  compiled flow runtime
- do not let generated JSON metadata become the canonical contract

## Deployment Compatibility

Compatibility should never change the deploy boundary:

- the deployable unit is still one compiled WASM runtime artifact
- the runtime artifact still embeds a callable manifest
- authorization and transport rules still wrap the compiled artifact

## Host-Specific Responsibilities

Older hosts may need adapters for:

- manifest translation
- request/response wrapper generation
- timer model bridging
- installation and loading conventions

Those adapters belong in host/tooling repos, not in the core runtime contract.

See also:

- [Host Capability Model](./HOST_CAPABILITY_MODEL.md)
