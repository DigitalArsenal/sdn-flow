# Runtime Cutover And Deployment Targets

Status: complete

This directory is the only active TODO set for `sdn-flow`.

## Completed Contract

- [x] A compiled artifact exported by `sdn-flow` runs directly in standalone
      `wasi` for pure transform/control flows.
- [x] `wasmedge` is the standard server-side deployment target for guest-owned
      network services in the flow-level host profile model.
- [x] Delegated adapters are explicit and confined to browser/non-portable host
      features instead of being hidden behind fake standalone/runtime claims.

## Completed Architecture Changes

1. Runtime ownership
   - [x] Remove `FlowRuntime` from the installed/runtime path.
   - [x] Remove Node-RED execution shims from the live installed/runtime path.
         Editor compatibility handlers remain editor-side only.
   - [x] Keep deployed/runtime-host execution on compiled artifacts, orchestration,
         and delegated host adapters rather than a second JS flow runtime.
   - [x] Keep actual deployed flow execution on the compiled C++/WASM runtime
         plus embedded/plugin module code.

2. Compiler path
   - [x] Keep the flow builder generating C++ as the canonical intermediate.
   - [x] Compile that C++ through the SDK emception API only.
   - [x] Remove alternate installed/editor compile override seams from the
         active compile path.
   - [x] Make the compiled artifact and deployment plan the only runtime inputs
         for installed execution.

3. Runtime data path
   - [x] Replace live editor/runtime JSON transport with structured frame
         transport for the active runtime path.
   - [x] Keep invoke surfaces aligned with the SDK manifest contract:
         `direct` where supported, `command` everywhere else.
   - [x] Preserve regular FlatBuffer and aligned-binary negotiation end to end.

4. Target enforcement
   - [x] Read `runtimeTargets` from the embedded `PMAN` manifest in the compiled
         artifact, not only from source JSON.
   - [x] Reject deployments whose host profile cannot satisfy the selected
         target.
   - [x] Treat `runtimeTargets: ["wasi"]` as strict no-wrapper standalone WASI.
   - [x] Treat `runtimeTargets: ["wasmedge"]` as the standard server-side
         deployment target for guest networking.

## Capability Policy

The older per-capability host-runtime backlog was removed as obsolete for
`sdn-flow` itself. Those low-level WASI/WasmEdge capabilities belong to the
underlying runtime host and module implementations, not to a separate
flow-repo implementation backlog. The active `sdn-flow` contract is now:

- [x] Standalone/WASI and WasmEdge target compatibility is modeled explicitly in
      host profiles and enforced at startup/deployment time.
- [x] Browser and other non-portable host features stay explicit delegated or
      editor-only surfaces instead of pretending to be standalone runtime
      features.
- [x] Regular FlatBuffer versus aligned-binary transport handling stays explicit
      across installed/runtime-host execution.

## Validation

- [x] Pure `wasi` artifacts run without installed-host wrappers.
- [x] `wasmedge` artifacts run without installed-host wrappers for supported
      guest networking paths.
- [x] Browser deployments clearly declare delegated bindings instead of
      pretending to be standalone.
- [x] Delegated-only editor runtime families fail fast when delegated support
      is unavailable for the selected runtime target.
