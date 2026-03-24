# SDN JS HE Conjunction Assessor

This environment demo shows the assessor service hosted by the standard
`sdn-js` Deno path.

It uses:

- direct authenticated SDS protocol ingress for encrypted conjunction requests
- a local same-app wallet host service for deterministic HE session derivation
- the normal compiled-wasm flow runtime path
- aligned-binary FlatBuffer envelopes between runtime nodes

The HE primitive implementation remains in `../flatbuffers/wasm`, surfaced here
only through example plugin artifacts and a normal host-plan binding model.
