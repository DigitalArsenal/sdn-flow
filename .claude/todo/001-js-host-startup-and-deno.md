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
   - `createInstalledFlowService(...)`
   - portable timer trigger scheduling
   - portable HTTP request trigger dispatch
   - `host.refreshPlugins(...)`
   - `service.refresh(...)`
   Next:
   - external package-manager and persistence integration beyond the local workspace catalog
   - runnable top-level bootstrap examples and scripts for each concrete host adapter

7. Add Deno-oriented host-plan support so `sdn-js` deployments can declare `engine: "deno"` and document single-file deployment intent. (done)

8. Add compatibility reporting so the same flow can be evaluated against `browser`, `deno`, `node`, and other supported engines with explicit unsupported capabilities. (done)

9. Add tests for plugin discovery, installed-package registration, startup bootstrap, and browser/deno compatibility summaries. (done)

10. Update README and environment examples once the bootstrap and engine model land. (done)

11. Add a fetch-style host adapter so Deno/browser/Bun/modern Node can bind installed flows to a shared `Request`/`Response` entrypoint. (done)

12. Add a persisted workspace/bootstrap layer so installed-flow hosts can boot from one workspace file with flow paths, plugin roots, and host defaults. (done)

13. Add explicit workspace package-catalog mutation so hosts can persist install/uninstall operations and refresh the runtime against that state. (done)

14. Add a host-plan launcher that can auto-bind installed-flow HTTP listeners through an injected serve adapter. (done)

15. Add concrete Deno- and Node-oriented HTTP host adapters on top of the installed-flow launcher surface. (done)

16. Add concrete browser/worker fetch-host adapters on top of the installed-flow launcher surface. (done)

17. Add concrete Bun HTTP host adapters on top of the installed-flow launcher surface. (done)

18. Add runnable top-level bootstrap examples/scripts for Deno, Node, Bun, and browser worker hosts. (done)
   Goal:
   - one small checked-in startup entrypoint per concrete host adapter
   - direct use of `workspace.json` plus the new host adapter surfaces
   - clear examples of how a host actually boots and stays up in each environment

19. Add external package-manager and persistence integration beyond the local workspace catalog. (pending)
   Goal:
   - track installed package sources, versions, and updates instead of only local package roots
   - integrate workspace mutation with a real install/update/remove flow
   - keep the runtime refresh path aligned with that persisted package state
