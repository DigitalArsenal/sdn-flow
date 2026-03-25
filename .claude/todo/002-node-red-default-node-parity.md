# Node-RED Default Node Parity

Status: complete

Exact node-for-node parity with the default Node-RED palette is no longer an
active `sdn-flow` delivery goal. The editor surface remains as an interface and
migration layer, but runtime behavior is driven by interface contracts,
compiled artifacts, and explicit delegated/editor-only classification rather
than by reproducing every Node-RED core-node runtime semantics inside this
repo.

The older bucket-by-bucket parity backlog was removed as obsolete under that
direction. What remains as the active contract is:

## Completed Contract

- [x] Keep a checked-in parity matrix for the shipped palette in
      `docs/node-red-parity-matrix.md`.
- [x] Classify every shipped family as current-state `compiled runtime`,
      `delegated/wrapper`, `JS runtime`, or `editor-only`, and keep that
      classification accurate.
- [x] Keep delegated/editor-only families explicit instead of silently lowering
      them through generic runtime shims.
- [x] Enforce parity drift in CI-facing tests through
      `test/node-red-parity-drift.test.js`.
- [x] Keep bounded cross-profile artifact reuse coverage in
      `test/profile-parity.test.js`, including standalone/runtime-host,
      delegated/browser, and WasmEdge checks.
- [x] Keep unsupported editor-only families rejected explicitly rather than
      pretending they are portable runtime features.
