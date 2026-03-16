# Field-Protected Catalog Entry

This example shows how `da-flatbuffers` and `hd-wallet-wasm` should appear on
the deploy path: as normal flow plugins with manifest-defined methods.

The flow:

1. extracts selected FlatBuffer fields
2. encrypts the protected field set
3. repacks the protected record
4. signs the protected payload

That keeps field-level protection and signatures inside the same compiled flow
model used for every other runtime feature.
