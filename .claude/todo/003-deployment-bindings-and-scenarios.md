# Deployment Bindings, Auth, And Scenario Validation

Status: active

## Deployment Plan Enforcement

- [ ] Consume and enforce the SDK deployment plan in the installed host path.
- [ ] Apply:
  - [x] `scheduleBindings`
  - [x] `serviceBindings`
  - [x] `authPolicies`
  - [x] `publicationBindings`
  - [x] `protocolInstallations`
  - [x] `inputBindings`
- [x] Persist deployment plans with archived artifacts and bundles, not only in
      transient deploy payloads.
- [x] Make browser/server delegated bindings explicit for:
  - filesystem
  - scheduler
  - inbound HTTP hosting
  - protocol hosting
  - storage/query surfaces

## Auth, Trust, And SDN/IPFS Integration

- [ ] Enforce approved-key trust mappings uniformly at request time.
- [ ] Use `hd-wasm-wallet` trust material for REST and IPFS/protocol services.
- [ ] Keep hosted protocol identity in the manifest and concrete routing in the
      deployment plan.
- [ ] Apply regular FlatBuffer versus aligned-binary negotiation consistently
      across installed services and module-to-module routing.

## Acceptance Scenarios

1. CSV OMM ingest and query service
   - [x] Build a flow that pulls CSV OMMs from Celestrak.
   - [x] Store them in FlatSQL on disk.
   - [x] Serve authenticated HTTPS REST queries over that store.

2. SDN/IPFS pull and pin workflow
   - [x] Import an entity profile message.
   - [x] Discover offered messages.
   - [x] Watch for publish notifications.
   - [x] Pull the data and apply user-configured pin/retention policy.

3. Scheduled space weather publisher
   - [x] Poll an upstream site on a schedule.
   - [x] Publish space-weather records plus a PNM.
   - [x] Keep pullable FlatBuffer data on disk.
   - [x] Expose the same data through FlatSQL REST queries.

4. Authenticated REST and IPFS services
   - [ ] Reject requests from unapproved keys.
   - [ ] Apply the same trust policy to REST, protocol, and IPFS surfaces.

5. Homomorphic conjunction service orchestration
   - [ ] Treat the HE implementation in `../flatbuffers/wasm` as the crypto
         primitive source of truth.
   - [ ] Make `sdn-flow` able to compose and deploy that service with the same
         compiled-runtime and deployment-plan path.

## Release Criteria

- [x] `npm test`
- [x] `node --test test/compiler.test.js test/compiled-artifact.test.js test/host.test.js`
- [x] `node --test test/editor-compile-artifact.test.js test/runtime.test.js`
- [x] scenario-specific regression flows checked into the repo
