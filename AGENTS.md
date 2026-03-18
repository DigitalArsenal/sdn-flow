# AGENTS

You are working in the flow repository. Use this repo to compose compliant
modules into flows, compile those flows into portable wasm runtime artifacts,
and wire host startup around the compiled artifact. Keep module-level rules in
`space-data-module-sdk`; consume them here rather than redefining them.

## What To Build Here

Build or change flow-level behavior here when the task involves:

- flow graph structure, node wiring, triggers, edges, and runtime descriptors
- compiled flow artifacts and their exported runtime/invocation/descriptor ABI
- hosted runtime planning, workspaces, startup surfaces, and host adapters
- deployment clients and flow-level packaging on top of the module contract
- installed plugin discovery, package catalogs, and host launch workflows

If the task changes plugin manifests, plugin ABI exports, capability IDs,
single-file module packaging, or module compliance rules, make the source-of-
truth change in `space-data-module-sdk` first and then consume that result here.

## How To Create A Compliant Flow

1. Start with compliant module manifests and plugin IDs. Reference those
   modules by `pluginId` and `methodId`; do not restate module ABI rules in this
   repo.
2. Model the flow as a normalized program like
   `examples/flows/single-plugin-flow.json`:
   - nodes call specific module methods
   - triggers define ingress
   - trigger bindings route ingress to node ports
   - edges connect output ports to downstream inputs
3. If the flow will be launched by a host, add a `host-plan.json` and
   `workspace.json` like the examples in `examples/environments`.
4. Compile the flow through `EmceptionCompilerAdapter` so the output is one
   compiled wasm runtime artifact with embedded manifest and exported flow ABI
   symbols.
5. For JS-family startup, use `createInstalledFlowApp(...)`,
   `startInstalledFlowAutoHost(...)`, or `sdn-flow-host`.
6. For non-JS hosts, load the same compiled artifact through the runtime,
   invocation, and descriptor ABIs in `src/host`.

## Portability Rules

Flows produced here are meant to stay portable across the same runtime families
used by the companion `flatbuffers/wasm` work:

- browser
- Node.js
- C#
- Go
- Java
- Kotlin
- Python
- Rust
- Swift

The built-in startup helpers in this repo cover browser, Deno, Bun, and Node.
The compiled flow artifact itself is broader than those helpers and should stay
language-neutral.

## Required Contract

Every compliant flow produced here should satisfy all of the following:

- module dependencies remain valid against `space-data-module-sdk`
- the compiled artifact embeds a FlatBuffer manifest
- the compiled artifact exports the runtime, invocation, and descriptor symbols
  expected by the ABI binders in `src/host`
- host startup surfaces launch the same compiled artifact instead of inventing a
  second flow runtime format
- environment-specific adapters stay thin wrappers over the same workspace,
  service, and compiled-artifact contract

## Integration Checks

Run these before you call the work complete:

- Always run:
  - `npm test`
- If you changed compiler output, compiled artifact layout, or flow ABI
  contracts:
  - `node --test test/compiler.test.js test/compiled-artifact.test.js test/host.test.js`
- If you changed startup surfaces, workspaces, package-manager integration, or
  host adapters:
  - `node --test test/installed-flow-host.test.js test/installed-flow-fetch.test.js test/installed-flow-app-host.test.js test/installed-flow-workspace.test.js test/http-host-adapters.test.js test/browser-host-adapters.test.js test/auto-host.test.js test/package-managers.test.js test/host-cli.test.js test/bootstrap-examples.test.js`
- If you changed environment demos or flow examples:
  - `node --test test/environment-demos.test.js test/example-flow.test.js test/infrastructure-plugins.test.js`
- If you changed auth, transport, or shared module compliance integration:
  - `npm run check:plugin-compliance`
  - `node --test test/plugin-compliance.test.js test/permissions.test.js test/pki.test.js`

## Practical Entry Points

- `src/runtime`: program normalization, runtime descriptors, `FlowRuntime`
- `src/compiler`: compiled flow artifact generation
- `src/host`: startup surfaces, workspace model, runtime ABI binders
- `src/deploy`: compiled-artifact deployment helpers
- `examples/bootstrap`: runnable startup entrypoints
- `examples/environments`: host-plan and workspace examples for JS, Go, and
  vendor-specific profiles
