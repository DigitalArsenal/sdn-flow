# sdn-flow Program

## Objective

Finish the `sdn-flow` runtime as a compiled C++/WASM system so OrbPro, Go SDN,
and standalone harnesses can load and execute the same single-artifact flow
runtime without introducing a second long-term JS execution path.

## Hard Rules

1. Deployment is exactly one compiled WASM artifact produced through
   `../emception`.
2. A plugin is a degenerate one-node flow; there is no separate deploy model
   for "just a plugin."
3. The embedded FlatBuffer manifest is required and callable from every built
   artifact.
4. Hosts provide capability wiring, startup, transport, and WASI-adjacent
   services only; hosts do not become the business-logic runtime.
5. JS files in `src/runtime` are temporary migration/reference harnesses, not
   the production runtime target.
6. Signed plugin artifacts are compile dependencies; plugin source is not
   required at deployment time.
7. Inter-plugin transport remains aligned SDS FlatBuffers, never JSON.

## Acceptance Gates

1. Every accepted change improves the compiled runtime path directly.
2. Safety must be non-decreasing: no silent JS fallback for deployable flows.
3. Deployability must be non-decreasing: the result still compiles to one WASM
   artifact with embedded manifest exports.
4. Host bindability must improve: compiled artifacts should expose enough
   descriptor/runtime ABI to let hosts introspect and drive execution without
   reverse-engineering generated memory layouts.

## Current Wave

Baseline:

- The compiled artifact already exports runtime state and queue/scheduler
  functions.
- Hosts still lack standalone exported descriptor-table entry points for nodes,
  edges, triggers, trigger bindings, external interfaces, and accepted types.

Selected improvement:

- Export the compiled descriptor tables and counts explicitly so host launchers
  can bind execution/introspection against stable symbols instead of depending
  on the monolithic runtime descriptor alone.
