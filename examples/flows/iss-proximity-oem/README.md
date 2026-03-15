# ISS Proximity OEM Flow

This example models a deployable `sdn-flow` graph that:

1. streams OMMs from SDN pubsub
2. ingests them into a FlatSQL storage plugin
3. queries all objects within `50 km` of `NORAD_CAT_ID=25544`
4. propagates each match for `90` samples across one orbit
5. generates OEMs
6. writes the OEMs to the local filesystem and republishes them to SDN

The canonical graph is in [flow.json](./flow.json). The visual editor can use
the embedded `editor` block to place nodes and groups without introducing a
second authoring format.

## External Inputs And Outputs

The flow requires:

- SDN pubsub input on `/sdn/catalog/omm`
- a timer that fires every `15000 ms`
- a FlatSQL storage plugin backend
- the example defaults to `memory://iss-proximity`
- hosts may satisfy the same plugin contract through a host storage adapter
- filesystem write access to `file:///var/tmp/sdn-flow/oem`
- SDN pubsub output on `/sdn/oem/iss-proximity`

## Signed Artifact Dependencies

`flow.json` also declares the signed plugin artifacts required to compile a
single deployable WASM bundle. The compiler does not need plugin source. It
embeds the signed artifact bytes and manifest bytes into one generated C++
translation unit, then compiles that translation unit through `../emception`.

## Expected Visual Layout

The graph is intentionally split into:

- ingest
- query
- analysis
- outputs

That gives a visual editor enough structure to present the example clearly while
still leaving the node/edge model fully data-driven.
