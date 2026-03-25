# Editor Executable Footprint

Measured on March 18, 2026 from `npm run build:editor-executable`.

## Current size

- initial `generated-tools/sdn-flow-editor`: `533M`
- initial Deno compile summary:
  - `Files: 454.18MB`
  - `Metadata: 2.8KB`
  - `Remote modules: 12B`

## What is actually taking space

Local disk usage around the compiled editor:

- `node_modules`: `199M`
- `../space-data-module-sdk`: `321M`
- `src/editor/embeddedAssets.generated.js`: `35M`
- `src/editor/nodeRedRegistry.generated.js`: `616K`

Largest directories under this repo's `node_modules`:

- `node_modules/@deno`: `93M`
- `node_modules/@node-red`: `37M`
- `node_modules/sql.js`: `18M`
- `node_modules/hd-wallet-wasm`: `8.5M`
- `node_modules/flatc-wasm`: `4.6M`
- `node_modules/flatsql`: `3.4M`

Largest path under the sibling SDK checkout:

- `../space-data-module-sdk/node_modules`: `317M`

## Deno graph facts

`./node_modules/.bin/deno info tools/sdn-flow-editor.ts` reports:

- initial editor graph: `120` modules, `34.91MB`
- current editor graph after import slimming and local runtime-constant snapshot: `31` modules, `34.44MB`
- `0` actual `http(s)` remote modules

Within this repo's `node_modules`, the current graph only touches:

- `hd-wallet-wasm`

Within the current graph, there are:

- `0` `space-data-module-sdk` modules
- `0` `@node-red/*` modules
- `0` `@deno/*` modules

The editor runtime also reaches into the sibling `space-data-module-sdk` through:

- `src/runtime/constants.js`
- `src/auth/*`
- `src/transport/*`
- `src/compliance/*`

Those imports explain why the compiled executable drags in the local `file:../space-data-module-sdk` dependency tree.

## Interpretation

- The `35M` embedded editor shell is real and expected from the current cloned-shell approach.
- The `321M` sibling SDK payload is mostly not source code; it is almost entirely `../space-data-module-sdk/node_modules`.
- The `199M` local `node_modules` payload is much larger than the runtime graph actually needs.
- The `Remote modules: 12B` compiler line does not correspond to live remote JS/TS imports in the editor graph. The graph itself reports zero `http(s)` modules, so that line is effectively negligible bookkeeping rather than an actual remote dependency path.

## What a first slimming pass changed

A first pass narrowed the editor executable imports so the Deno host now reaches:

- `src/deploy/compiledArtifact.js` instead of the broader deployment client barrel
- `src/host/compiledFlowRuntimeHost.js` instead of `src/host/index.js`
- subprocess-only editor preview/build bridges instead of importing the compiler path at module load time

That did reduce the visible host-side source closure in the compile summary, but it did **not** materially change the overall executable size:

- before: `Files: 454.18MB`
- after: `Files: 453.99MB`

That result means the dominant remaining payload is not the broad host barrel by itself. The next reduction has to target the still-live `space-data-module-sdk` dependency path coming through `src/runtime/constants.js` and the generated editor asset payload.

After generating a local runtime-constants snapshot, the module graph no longer references the sibling SDK at all. Even so, the Deno compile summary still embeds `space-data-module-sdk/*` and `node_modules/*`.

That means the next size reduction is no longer about import trimming. It has to change the executable build workspace/packaging step itself so Deno compiles from a minimal closure instead of the full repo package environment.

## Post-cleanup footprint

After switching the executable build to compile from a staged workspace that only contains the actual editor graph and the packages that graph touches:

- Deno compile summary:
  - `Files: 42.92MB`
  - `Metadata: 1.79KB`
  - `Remote modules: 12B`
- Embedded file groups:
  - `node_modules/*`: `8.48MB`
  - `package.json`: `76B`
  - `src/*`: `34.44MB`
  - `tools/*`: `18.39KB`

## Why residue remains

The remaining footprint is now dominated by two things:

- the embedded editor shell bundle in `src/editor/embeddedAssets.generated.js` (`33.67MB`)
- the `hd-wallet-wasm` package required by `src/utils/wasmCrypto.js` (`8.48MB` in the staged build)

The build no longer embeds:

- the sibling `space-data-module-sdk/*` tree
- the full repo `node_modules/*`
- the broad host/compiler/package-manager closure that was previously reachable only because the executable was compiled from the full repo workspace

## Immediate strip candidates

- Stop embedding the sibling SDK's `node_modules` tree in the editor executable.
- Stop embedding unused local dev packages such as `@node-red/*` once the generated asset bundle is the only editor shell input.
- Revisit whether `@deno/*` platform packages need to be present in the compiled runtime closure at all.
- Shrink `embeddedAssets.generated.js` by removing more unused upstream assets instead of only branding/documentation surfaces.
