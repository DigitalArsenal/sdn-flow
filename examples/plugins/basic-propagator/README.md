# Basic Propagator Plugin

This example shows the minimum shape of a propagator-style plugin in the
`sdn-flow` architecture.

The example uses:

- one input method: `propagate`
- a request input port
- a state output port
- a manifest that can be embedded into a compiled artifact

## Files

- `manifest.json` shows the canonical method and port contract
- `plugin.js` shows a host-side registration example for the portable runtime

## Runtime Notes

- The deployable form of this plugin is still a compiled WASM runtime artifact.
- The embedded FlatBuffer manifest is the runtime source of truth.
- A single-plugin flow can wrap this plugin directly without introducing a
  second deployment model.
