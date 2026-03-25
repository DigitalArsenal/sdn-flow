# Runtime Cutover And Deployment Targets

Status: active

This directory is the only active TODO set for `sdn-flow`.

## Goal

- [ ] A compiled artifact exported by `sdn-flow` must run directly in a full
      standalone `wasi` environment for pure transform/control flows.
- [ ] `wasmedge` is the standard server-side deployment target for guest-owned
      network services.
- [ ] Wrappers or delegated adapters exist only where there is no portable WASI
      surface, especially in browsers and for non-portable host features.

## Required Architecture Changes

1. Runtime ownership
   - [x] Remove `FlowRuntime` from the installed/runtime path.
   - [ ] Remove remaining Node-RED execution shims from the live runtime path.
   - [ ] Keep JavaScript limited to editor UI, orchestration, and delegated host
         adapters only.
   - [ ] Move actual flow execution semantics into compiled C++/WASM.

2. Compiler path
   - [ ] Keep the flow builder generating C++ as the canonical intermediate.
   - [x] Compile that C++ through the SDK emception API only.
   - [ ] Remove any remaining fake, filesystem-backed, or alternate emception
         paths.
         Installed live compilation now rejects `compileArtifact`,
         `compiler`, `emception`, `emceptionSessionFactory`, and
         `sourceGenerator` seams; remaining alternate paths are elsewhere.
   - [x] Make the compiled artifact and deployment plan the only runtime inputs
         for installed execution.

3. Runtime data path
   - [ ] Replace editor/runtime JSON `msg` plumbing with typed frame transport.
   - [ ] Keep invoke surfaces aligned with the SDK manifest contract:
         `direct` where supported, `command` everywhere else.
         Dependency metadata and emitted manifests now preserve/derive
         `invokeSurface` / `invokeSurfaces`; remaining work is the broader live
         runtime path.
   - [ ] Preserve regular FlatBuffer and aligned-binary negotiation end to end.

4. Target enforcement
   - [x] Read `runtimeTargets` from the embedded `PMAN` manifest in the compiled
         artifact, not only from source JSON.
   - [x] Reject deployments whose host profile cannot satisfy the selected
         target.
   - [x] Treat `runtimeTargets: ["wasi"]` as strict no-wrapper standalone WASI.
   - [ ] Treat `runtimeTargets: ["wasmedge"]` as the standard server-side
         deployment target for guest networking.

## Capability Policy

Standalone `wasi`:
- [ ] stdin/stdout/stderr
- [ ] args/env
- [ ] clock/random
- [ ] preopened filesystem
- [ ] pipes/streams
- [ ] direct method invocation via typed frames
- [ ] deterministic transform/control nodes

`wasmedge`:
- [ ] DNS/socket/TLS-backed guest networking
- [ ] HTTP/TCP/UDP services owned by the guest
- [ ] libp2p/IPFS protocol handle/dial surfaces where implemented in guest code
- [ ] WebSocket and MQTT via guest libraries over sockets/TLS

Delegated or wrapper-only:
- [x] browser inbound listeners
- [ ] browser filesystem beyond the chosen portable adapter
- [ ] file watch
- [ ] cron scheduling
- [ ] wall-clock `delay`/`trigger` scheduling semantics
- [ ] `exec` and process control
- [ ] any capability with no portable WASI surface on the target host

## Validation

- [x] Pure `wasi` artifacts run without installed-host wrappers.
- [x] `wasmedge` artifacts run without installed-host wrappers for supported
      guest networking paths.
- [x] Browser deployments clearly declare delegated bindings instead of
      pretending to be standalone.
- [x] Delegated-only editor runtime families fail fast when delegated support
      is unavailable for the selected runtime target.
