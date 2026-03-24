# HE Conjunction Assessor

This example models the assessor-side service for encrypted conjunction
assessment.

The flow:

1. derives an HE public bundle from the local wallet-backed assessor identity
2. computes encrypted pairwise distance for the submitted ephemeris pair
3. emits a typed threshold decision from the compiled flow runtime

Each node boundary stays on a shared aligned-binary FlatBuffer envelope
(`AlignedRecordBatch.fbs`) instead of introducing ad hoc JSON or custom wire
types for the HE request/session/result path.

The crypto primitive source of truth stays in `../flatbuffers/wasm`, consumed
through the `flatc-wasm` `./he` and `./he-bridge` exports. This repo only
composes and deploys that service through the standard flow/runtime path.

The request path is intentionally direct and authenticated. Encrypted ephemeris
is treated as sensitive transport data and does not go through pubsub.
