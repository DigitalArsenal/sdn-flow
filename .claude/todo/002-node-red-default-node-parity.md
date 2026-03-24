# Node-RED Default Node Parity

Status: active

## Goal

- [ ] Reach practical parity for the default shipped node families while keeping
      maximum WASI compatibility.
- [ ] Classify every shipped node as one of:
  - standalone `wasi`
  - `wasmedge`
  - delegated/wrapper

## Standalone `wasi` Bucket

- [ ] `change`
- [ ] `switch`
- [ ] `range`
- [ ] `template`
- [ ] `json`
- [ ] `csv`
- [ ] `yaml`
- [ ] `xml`
- [ ] `html`
- [ ] `split`
- [ ] `join`
- [ ] `batch`
- [ ] `sort`
- [ ] `rbe`
- [ ] `link in`
- [ ] `link out`
- [ ] `link call`
- [ ] `debug`
- [ ] immediate/manual `inject`
- [ ] `read file` and `write file` on preopened roots

## `wasmedge` Bucket

- [ ] `http request`
- [ ] `http in`
- [ ] `http response`
- [ ] TCP request/listener nodes
- [ ] UDP in/out nodes
- [ ] TLS-backed client/server nodes
- [ ] WebSocket in/out nodes via guest libraries
- [ ] MQTT in/out nodes via guest libraries
- [ ] protocol handle/dial nodes for SDN/IPFS-facing services

## Delegated/Wrapper Bucket

- [ ] `watch`
- [ ] cron-style `inject`
- [ ] wall-clock `delay`
- [ ] wall-clock `trigger`
- [ ] `exec`
- [ ] `catch`
- [ ] `status`
- [ ] `complete`
- [ ] browser-local inbound listener behavior
- [ ] browser-only or OS-only watch/process semantics

## Required Work

1. Inventory
   - [x] Build a checked-in parity matrix covering every shipped node. See
         `docs/node-red-parity-matrix.md`.
   - [x] Mark current implementation state:
         editor-only, JS runtime, compiled runtime, delegated.
         See `docs/node-red-parity-matrix.md`.

2. Compiled implementations
   - [ ] Move remaining deterministic node semantics into compiled C++/WASM.
   - [ ] Implement guest-owned network node families against the `wasmedge`
         target.
   - [x] Keep the delegated bucket explicitly small and documented.
         Editor-only live-runtime families are now rejected through
         `src/editor/liveRuntimeSupport.js` instead of falling through generic
         live artifact lowering.

3. Tests
   - [x] Add parity drift enforcement that checks the matrix against the
         shipped palette/runtime support in code.
   - [ ] Add end-to-end flows for every shipped node family.
   - [ ] Run the same flow artifacts against:
         standalone `wasi`, `wasmedge`, and delegated/browser profiles where
         applicable.
         A bounded harness now exists in `test/profile-parity.test.js` for
         standalone/runtime-host/delegated reuse; `wasmedge` coverage is still
         open.
   - [ ] Keep parity regressions in CI before expanding the default node set.
