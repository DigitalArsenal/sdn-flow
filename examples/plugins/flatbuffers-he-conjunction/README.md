# FlatBuffers HE Conjunction

This example manifest keeps the actual homomorphic primitive implementation in
`flatc-wasm`.

The intended backing exports are:

- `./he`

`sdn-flow` uses this manifest to compose the assessor service as a normal flow
graph and to carry the deployment metadata needed to host that service.
