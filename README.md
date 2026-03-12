# sdn-flow

`@digitalarsenal/sdn-flow` is the standalone flow package for OrbPro and Space
Data Network.

It is deliberately not a monorepo-internal runtime. The intended model is:

- Author flows locally in UI code against this package.
- Treat a single plugin as the degenerate case of a flow.
- Compile every deployable flow into one executable WASM runtime artifact.
- Embed the flow manifest as FlatBuffer bytes and expose callable manifest
  export symbols in every deployable artifact.
- Sign deployment authorization with SDN HD wallet keys.
- Optionally encrypt the deployment package in transit with PKI.
- Deploy the compiled WASM artifact locally or to a remote SDN/OrbPro host.

## Scope

This package provides:

- an isomorphic flow runtime for authoring, testing, and host-side execution
- a UI-facing designer session API
- deployment authorization helpers for HD-wallet-signature workflows
- PKI transport helpers for encrypted deployment payloads
- a deployment client that moves compiled single-WASM flow artifacts

This package does not embed OrbPro schemas or compile WASM itself. A host repo
provides the compiler adapter, typically backed by `emception`.

## Design Rules

- Deployment is always a compiled WASM runtime artifact, never a raw graph.
- A single plugin is a valid one-node flow.
- Local and remote deployment use the same signed artifact envelope.
- Remote deployment may encrypt transport, but encryption is not the artifact.
- UI code consumes controllers and contracts here; it should not own protocol
  rules, signature formats, or deployment envelope logic.

## Package Surface

- `@digitalarsenal/sdn-flow/runtime`
- `@digitalarsenal/sdn-flow/designer`
- `@digitalarsenal/sdn-flow/auth`
- `@digitalarsenal/sdn-flow/transport`
- `@digitalarsenal/sdn-flow/deploy`

## Compiler Boundary

The package expects a compiler adapter with this shape:

```js
const artifact = await compiler.compile({
  program,
  target,
  metadata,
});
```

The returned artifact must include the compiled WASM bytes and deployment
metadata, including the embedded FlatBuffer manifest bytes and callable manifest
symbols. The deploy client will only ship that artifact, not the source graph.

## Local vs Remote Deploy

Both modes use the same deployment payload:

1. Compile the flow to one WASM runtime artifact.
2. Create a signed deployment authorization envelope.
3. Wrap the artifact and authorization in a deployment package.
4. Optionally encrypt the package for the remote recipient.
5. Send it to a local adapter or remote HTTP endpoint.

## Status

This repo currently contains the portable runtime, authorization, transport, and
deployment scaffolding. Host-specific OrbPro and SDN adapters belong in their
respective repos.
