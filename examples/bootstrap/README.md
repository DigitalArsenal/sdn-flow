# Bootstrap Examples

These are minimal runnable host-entrypoint examples for the concrete
installed-flow adapters, the packaged editor runtime, plus one
environment-neutral auto-host launcher.

They intentionally use one in-memory HTTP responder plugin instead of the
larger environment demos, so every script here is actually runnable without a
separate package-install step.

Files:

- `installed-flow-http-demo.js`
  Shared workspace factory used by every bootstrap example.
- `start-deno-http-host.mjs`
  Minimal Deno HTTP host bootstrap using `startInstalledFlowDenoHttpHost(...)`.
- `start-node-http-host.mjs`
  Minimal Node HTTP host bootstrap using `startInstalledFlowNodeHttpHost(...)`.
- `start-bun-http-host.mjs`
  Minimal Bun HTTP host bootstrap using `startInstalledFlowBunHttpHost(...)`.
- `start-browser-worker.mjs`
  Minimal browser/worker bootstrap using `startInstalledFlowBrowserFetchHost(...)`.
- `start-auto-host.mjs`
  Environment-neutral bootstrap using `startInstalledFlowAutoHost(...)` and a checked-in `workspace.json`.
- `start-node-editor-host.mjs`
  Minimal Node bootstrap for the hosted editor runtime using `startSdnFlowEditorNodeHost(...)`.

These examples are meant to show the host startup shape directly:

1. define or load one workspace
2. hand it to the concrete host adapter, or the auto-host dispatcher
3. let the selected adapter own listener registration for that environment
