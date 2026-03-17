1. Add explicit JS-host engine modeling for `node`, `deno`, `bun`, and `browser`. (done)

2. Keep one `sdn-js` adapter family while allowing environment-specific compatibility summaries. (done)

3. Add installed plugin package discovery for Node/JS hosts so packages can be scanned from directories with `manifest.json` and optional `plugin.js`. (done)

4. Add environment-neutral installed plugin loading so browser/Deno hosts can supply in-memory manifests/modules instead of filesystem discovery. (done)

5. Add a bootstrap API that discovers/registers installed plugins and loads a flow program into a runtime. (done)

6. Make the bootstrap API usable for Node-RED-style “install nodes and startup” flows. (partial)
   Done:
   - `createInstalledFlowHost(...)`
   - package discovery and registration
   - flow program load + runtime drain bootstrap
   Next:
   - long-running timers / HTTP listeners / runtime services that remain active after startup
   - package install/update lifecycle beyond local discovery

7. Add Deno-oriented host-plan support so `sdn-js` deployments can declare `engine: "deno"` and document single-file deployment intent. (done)

8. Add compatibility reporting so the same flow can be evaluated against `browser`, `deno`, `node`, and other supported engines with explicit unsupported capabilities. (done)

9. Add tests for plugin discovery, installed-package registration, startup bootstrap, and browser/deno compatibility summaries. (done)

10. Update README and environment examples once the bootstrap and engine model land. (done)
