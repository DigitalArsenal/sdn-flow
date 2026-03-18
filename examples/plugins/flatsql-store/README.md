# FlatSQL Storage Plugin

This example defines the canonical `sdn-flow` view of FlatSQL: it is a storage
plugin/runtime, not an implicit engine subsystem.

The plugin owns:

- aligned FlatBuffer ingest
- query methods
- the logical FlatSQL dataset exposed to the rest of the flow

The host only provides the storage backing when needed.

Supported backing modes:

- `memory`: transient in-process storage
- `host-adapter`: persistence/query delegated through a host storage adapter

## Files

- `manifest.json` defines the canonical storage plugin contract
- `plugin.js` provides a local FlatSQL-backed host implementation for tests and
  local runtime development

## Runtime Notes

- The plugin accepts arbitrary aligned FlatBuffer payloads, including
  REC-wrapped SDS records.
- The same plugin contract can back an in-memory database or a host-provided
  storage adapter without changing the flow graph.
- Deployment still compiles into one WASM runtime artifact; the host only
  supplies the selected storage capability binding.
