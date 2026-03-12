# Compatibility Model

## Goal

`sdn-flow` is the canonical plugin/flow runtime model. Compatibility layers
exist only to bridge older hosts and older metadata formats into that model.

## What Stays Canonical

These remain canonical:

- typed manifest-driven methods
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
