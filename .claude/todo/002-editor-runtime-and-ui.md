1. Replace the current docs-only editor shell with a stronger flow-editor layout that feels like a real hosted runtime console. (done)
   Done:
   - redesigned palette, workspace chrome, inspector, generated-runtime viewer, and debug sidebar
   - kept the existing SVG flow canvas and compile/deploy flow while moving output into structured debug events

2. Remove CDN-only editor dependencies so the editor runtime can be embedded and shipped without network fetches for core UI behavior. (done)
   Done:
   - removed Monaco and the browser import-map dependency from the core editor shell
   - replaced the generated-source panel with a bundled code viewer
   - kept toolchain fetches in the compiler workers isolated from the core UI runtime

3. Add a debug node kind and a debug sidebar/panel with structured runtime-style event inspection. (done)
   Done:
   - added a persistent `debug` node kind with saved config
   - added structured debug entry list/detail rendering
   - routed compile, deploy, manifest, and workspace events through the debug sidebar and debug-node taps

4. Add an embeddable editor runtime API that serves the editor from embedded assets through a fetch handler. (done)
   Done:
   - `createSdnFlowEditorFetchHandler(...)`
   - generated embedded asset bundle from `docs/`
   - bootstrap, export, and deploy API routes for embedded hosts

5. Add a Deno-first single-file editor launcher that can be compiled into one executable. (done)
   Done:
   - `tools/sdn-flow-editor.ts`
   - Deno startup surface via `startSdnFlowEditorDenoHost(...)`
   - documented `deno compile` path for one executable

6. Add a Node-oriented editor host CLI for local development and parity with the existing installed-flow host CLI. (done)
   Done:
   - `bin/sdn-flow-editor.js`
   - `startSdnFlowEditorNodeHost(...)`
   - CLI support for host, port, base path, title, and initial flow JSON

7. Add tests for embedded editor asset serving, bootstrap/config endpoints, and editor host CLI behavior. (done)
   Done:
   - `test/editor-runtime.test.js`
   - `test/editor-cli.test.js`
   - editor bootstrap example coverage in `test/bootstrap-examples.test.js`
   - full `npm test` passing

8. Update the README and examples to document embeddable hosting and Deno single-file deployment of the editor runtime. (done)
   Done:
   - README editor runtime section with embed, CLI, and Deno single-file usage
   - `examples/bootstrap/start-node-editor-host.mjs`
   - updated bootstrap examples README
