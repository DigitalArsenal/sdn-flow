# FlatBuffers HE Session

This example manifest models the assessor-side HE session bootstrap as a normal
flow plugin.

The implementation source of truth is the sibling `../flatbuffers/wasm` work,
consumed through the published `flatc-wasm` package exports:

- `./he`
- `./he-bridge`

`sdn-flow` only composes this capability into a flow and deployment plan. It
does not define a second HE primitive model here.
