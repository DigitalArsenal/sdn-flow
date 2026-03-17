# Plugin Compliance Checks

`space-data-module-sdk` owns the canonical plugin/module API and ABI
compliance checks for Space Data Network repositories.

`sdn-flow` consumes those checks and may provide thin wrappers so flow repos can
run the same canonical validation without forking the rules.

Use this tooling when a repo touches:

- plugin manifests
- plugin ABI export symbols
- compiled WASM plugin artifacts
- capability declarations
- external interface declarations

## Canonical Rules

The compliance checker enforces the portable module/plugin rules defined in
`space-data-module-sdk`:

- plugins are manifest-defined deployable units
- plugins embed a FlatBuffer manifest
- plugin artifacts expose:
  - `plugin_get_manifest_flatbuffer`
  - `plugin_get_manifest_flatbuffer_size`
- manifests declare method contracts, not ad hoc payloads
- capability and external-interface surfaces are explicit

## Commands

Scan a repo for plugin manifests:

```bash
node tools/run-plugin-compliance-check.mjs --repo-root .
```

Target the repo scan with `sdn-plugin-compliance.json` at the repo root:

```json
{
  "scanDirectories": ["examples/plugins"],
  "manifestPaths": ["plugins/example/manifest.json"],
  "allowEmpty": false
}
```

When that file exists, the checker uses it instead of crawling the entire repo.
Use `allowEmpty: true` only in repos that do not yet ship canonical plugin
manifests but still need the shared check wired in.

Validate one manifest directly:

```bash
node tools/run-plugin-compliance-check.mjs --manifest ./examples/plugins/basic-propagator/manifest.json
```

Validate manifest plus compiled ABI exports:

```bash
node tools/run-plugin-compliance-check.mjs \
  --manifest ./manifest.json \
  --wasm ./dist/plugin.wasm
```

Emit JSON:

```bash
node tools/run-plugin-compliance-check.mjs --repo-root . --json
```

## Shared-Repo Pattern

Other Space Data Network repositories should not fork this checker.

They should:

1. load the shared checker from `space-data-module-sdk`
2. optionally call it through thin wrappers in `sdn-flow`
3. keep only thin repo-local wrapper scripts if they want shorter commands

That preserves one plugin ABI and one compliance implementation.
