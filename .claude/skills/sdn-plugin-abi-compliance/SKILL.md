# SDN Plugin ABI & Compliance

Use this skill whenever a task touches:

- plugin API/ABI rules
- manifest shape
- embedded manifest exports
- plugin compliance gates
- cross-repo SDN plugin architecture

## Canonical source of truth

- `docs/PLUGIN_ARCHITECTURE.md`
- `docs/PLUGIN_MANIFEST.md`
- `docs/HOST_CAPABILITY_MODEL.md`
- `docs/PLUGIN_COMPATIBILITY.md`
- `docs/PLUGIN_COMPLIANCE_CHECKS.md`

## Hard rules

1. A plugin is a degenerate one-node flow.
2. Deployable artifacts embed a FlatBuffer manifest.
3. Plugin artifacts expose:
   - `plugin_get_manifest_flatbuffer`
   - `plugin_get_manifest_flatbuffer_size`
4. Hosts bridge capabilities; they do not fork the plugin ABI.
5. Capability and external-interface requirements must be explicit.

## Compliance workflow

1. Validate the manifest contract first.
2. Validate compiled ABI exports when a `.wasm` artifact exists.
3. Do not invent repo-local ABI variants.
4. Use the shared checker in this repo instead of copying new compliance logic elsewhere.

## Commands

Repo scan:

```bash
node tools/run-plugin-compliance-check.mjs --repo-root .
```

If a repo needs targeted scanning, add `sdn-plugin-compliance.json` at its root
and keep only manifest paths or scan directories there.

Manifest plus wasm artifact:

```bash
node tools/run-plugin-compliance-check.mjs --manifest ./manifest.json --wasm ./dist/plugin.wasm
```

## Cross-repo rule

Other Space Data Network repos should call this checker through thin wrapper
scripts only. The actual API/ABI logic must live here in `sdn-flow`.
