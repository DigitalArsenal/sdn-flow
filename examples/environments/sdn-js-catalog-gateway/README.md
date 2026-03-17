# sdn-js Catalog Gateway

This demo is the shared JS-host profile example for Node, Deno, and Bun.

The checked-in `host-plan.json` uses `engine: "deno"` as the preferred
single-file deployment target for the `sdn-js` host family. The same flow can
still be evaluated against `node`, `bun`, or `browser` with explicit
capability-compatibility reporting.

The checked-in `workspace.json` shows the persisted installed-flow startup
shape: flow path, host-plan path, plugin roots, and fetch/service defaults that
`createInstalledFlowApp(...)` can boot directly. For the Deno path, the
intended launcher is `startInstalledFlowDenoHttpHost({ workspacePath })`.

It uses:

- timer trigger
- outbound HTTP fetch
- filesystem output
- pipe logging
- inbound HTTP request handling

If one JS runtime cannot satisfy one of those capabilities, that gap should be
documented as unsupported for the host profile rather than solved by a new
plugin ABI.
