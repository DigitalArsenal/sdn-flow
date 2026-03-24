# Environment Demos

These examples make the host profiles explicit instead of assuming that
"WASI" or "JavaScript" is enough detail.

For minimal runnable startup entrypoints against the concrete JS-host adapters,
see [../bootstrap/README.md](../bootstrap/README.md).

Each demo includes:

- `flow.json`: the canonical `sdn-flow` graph
- `host-plan.json`: the runtime placement and binding profile
- `workspace.json`: persisted startup config when the demo includes an installed-flow host workspace
- `README.md`: the intended environment and capability notes

Available demos:

- `orbpro-browser-omm-cache`
- `sdn-js-catalog-gateway`
  Preferred `sdn-js` engine: `deno` for single-file host deployment.
- `sdn-js-he-conjunction-assessor`
- `go-sdn-omm-service`
- `wasmedge-udp-spooler`
