# Basic Sensor Plugin

This example shows the minimum shape of a sensor-style plugin in the
`sdn-flow` architecture.

The example uses:

- one input method: `detect`
- a target input port
- a detection output port
- a manifest suitable for embedding into a compiled artifact

## Files

- `manifest.json` shows the canonical method and port contract
- `plugin.js` shows a host-side registration example for the portable runtime

## Runtime Notes

- The deployable form of this plugin is still a compiled WASM runtime artifact.
- The embedded FlatBuffer manifest is mandatory at deploy time.
- A sensor can run alone as a one-node flow or participate in a larger graph.
