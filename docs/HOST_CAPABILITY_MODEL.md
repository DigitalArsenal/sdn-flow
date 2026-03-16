# Host Capability Model

## Purpose

This document defines how compiled `sdn-flow` and OrbPro runtime artifacts ask
for host functionality such as timers, clock, randomness, network access,
filesystem access, pipes, protocol bindings, storage, and pubsub.

The goal is to keep one runtime model across OrbPro, `sdn-js`, Go SDN, and
WASI-style hosts without creating a different plugin ABI or a different deploy
shape for each environment.

## Hard Rules

1. Every deployable unit is one compiled WASM runtime artifact.
2. Every module is a flow. A "single plugin" is a degenerate one-node flow.
3. Hosts provide capabilities and placement, not business logic.
4. Capability requirements must be explicit in manifests, flow programs,
   hosted-runtime plans, or deployment envelopes. Do not hide them in ad hoc
   host config or implicit imports.
5. Use the minimum host-adapter set needed to cover environment families.
   Do not add a new harness just because one runtime exposes a feature
   differently.
6. Generic "WASI" is not a sufficient capability claim. If a flow needs more
   than the portable baseline, the required host profile and imports must be
   documented explicitly.
7. If there is no compiled-host path for a required feature in a target
   environment, treat that as a release-blocking alert. Do not paper over it
   with loose JS wrappers, host cron jobs, or sidecar-only glue.

## Capability Declaration Surfaces

Use the surfaces below together. They solve different problems.

| Surface                                         | Purpose                                    | Example                                           |
| ----------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `manifest.capabilities`                         | coarse approval/signing scope              | `["timers", "http", "storage_write"]`             |
| `manifest.externalInterfaces`                   | concrete plugin-level bindings             | outbound HTTP, FlatSQL adapter, filesystem path   |
| `program.externalInterfaces`                    | flow-level bindings beyond a single plugin | shared HTTPS listener, shared pubsub topic        |
| `program.triggers`                              | trigger ownership                          | timer, protocol request, HTTP request             |
| hosted-runtime plan `requiredCapabilities`      | runtime placement/startup requirements     | early local service needs `protocol_handle`       |
| deployment authorization `requiredCapabilities` | signed approval at deploy time             | remote install allowed to use `pubsub` and `ipfs` |

Keep capability IDs coarse and stable. Put transport-specific details in the
interface object, not in a proliferating list of near-duplicate capability
strings.

## Canonical Capability Guidance

Recommended coarse capability IDs:

- `clock`
- `random`
- `timers`
- `http`
- `network`
- `filesystem`
- `pipe`
- `pubsub`
- `protocol_handle`
- `protocol_dial`
- `database`
- `storage_adapter`
- `storage_query`
- `storage_write`
- `wallet_sign`
- `ipfs`
- `scene_access`
- `render_hooks`

Guidance:

- Use `network` for raw sockets, TCP, UDP, QUIC, or similar transport access.
- Use `http` for HTTP client/server semantics instead of encoding HTTP as a
  special case of raw sockets.
- Use `filesystem` for path-backed storage and `database` for logical database
  interfaces such as FlatSQL.
- Use `pipe` for stdin/stdout/stderr, named pipes, or stream-style host I/O.
- Keep `ipfs` coarse. Pinning, block get/put, and publish behavior belong in
  interface metadata.
- Compute-only infrastructure plugins such as DA FlatBuffers usually need no
  host capability at all. `hd-wallet-wasm` style plugins should only declare
  host capabilities such as `random` or `wallet_sign` when they genuinely need
  host-provided entropy or resident key material.

## External Interface Patterns

External interfaces carry the precise runtime binding details. Keep the
interface kinds small and use `properties` for specialization.

### Timer / Clock / Randomness

- Timers normally enter through `program.triggers`.
- If a plugin needs direct time or entropy outside trigger scheduling, declare
  `clock` and `random` capabilities explicitly.
- Do not let native code silently reach into browser globals or host globals.
  Entropy and time should enter through explicit host capabilities.

### HTTP

Use `kind: "http"` for both outbound requests and inbound handlers.

Example:

```json
{
  "interfaceId": "celestrak-fetch",
  "kind": "http",
  "direction": "output",
  "capability": "http",
  "resource": "https://celestrak.org",
  "required": true,
  "properties": {
    "methods": ["GET"],
    "purpose": "Fetch OMM updates"
  }
}
```

### Raw Network / TCP / UDP

Use `kind: "network"` and put socket details in `properties`.

Example:

```json
{
  "interfaceId": "udp-observation-ingest",
  "kind": "network",
  "direction": "input",
  "capability": "network",
  "resource": "udp://0.0.0.0:40123",
  "required": true,
  "properties": {
    "transport": "udp",
    "mode": "listen"
  }
}
```

This avoids separate ABIs for TCP, UDP, raw sockets, and runtime-specific
socket APIs.

### Filesystem / Pipes

Use `kind: "filesystem"` for path-backed files and `kind: "pipe"` for stream
or pipe semantics.

Example:

```json
{
  "interfaceId": "oem-export-dir",
  "kind": "filesystem",
  "direction": "output",
  "capability": "filesystem",
  "resource": "file:///var/lib/sdn/oem",
  "required": true,
  "properties": {
    "access": "read-write"
  }
}
```

```json
{
  "interfaceId": "stderr-log",
  "kind": "pipe",
  "direction": "output",
  "capability": "pipe",
  "resource": "stderr",
  "required": false
}
```

### Database / FlatSQL

Storage engines remain plugins or explicit host services, not hidden host
subsystems.

- Use `kind: "database"` for the logical database surface seen by the flow.
- Use `kind: "host-service"` when the flow needs a host-provided storage
  adapter contract.

### IPFS / SDS Protocol / Other Services

If a function is logically a networked platform service rather than a raw
socket, prefer `kind: "host-service"`, `kind: "protocol"`, or `kind: "pubsub"`
plus explicit `resource`, `protocolId`, `topic`, or `properties`.

Examples:

- IPFS pinning service
- SDS PNM notification channel
- local orbit-determination service runtime
- same-app licensing runtime

## Environment Profiles

The canonical model is shared, but capability availability differs by host
profile. Document the profile. Do not claim "runs anywhere" unless it is true
for the declared interfaces.

### OrbPro Browser Host

Portable expectations:

- `clock`, `random`, `timers`
- outbound HTTP
- same-app bindings
- browser-managed storage surfaces
- scene/render integration
- `sdn-js` protocol/pubsub integration when configured

Non-portable or unavailable by default:

- raw TCP/UDP sockets
- arbitrary listen sockets
- unrestricted filesystem access
- OS pipes

If a flow needs those features, place that runtime in a different host profile
instead of pretending the browser host can satisfy them.

### Node / Deno / Bun Through The `sdn-js` Host Family

Expected direction:

- keep one `sdn-js` host family for browser-capable and JS-capable runtimes
- expose files, pipes, outbound HTTP, protocol/pubsub, IPFS, and local
  listeners through the same capability model
- document unsupported features per runtime instead of creating a new plugin
  ABI for each JS engine

If one engine cannot provide a capability in compiled-host form, mark that
capability unsupported for that profile.

### Go SDN Host

This is the preferred profile for long-running service flows such as:

- timer-triggered OMM sync
- FlatSQL-backed local storage
- HTTPS serving
- IPFS publish and pin
- SDS protocol notifications
- local orbit determination and association jobs

The flow still deploys as one compiled WASM artifact. The Go host supplies the
bindings.

### Generic WASI Runtime

Treat generic WASI as a narrow portability baseline only.

Portable assumptions:

- startup entrypoint
- stdio-like behavior
- linear memory/exported symbol access
- whatever explicit imported host functions the host provides

Do not assume from "WASI" alone:

- outbound HTTP
- sockets
- persistent filesystem semantics
- timers beyond what the host explicitly exposes
- pubsub, protocol, IPFS, or database services

### WasmEdge / Wasmtime / Wasmer / Wazero

Vendor or runtime extensions may be used, but they do not change the canonical
flow ABI.

Rules:

- declare the same capability IDs and interface shapes
- document the exact host profile or extension required
- do not describe the result as generic-WASI portable unless the same compiled
  contract is actually supported elsewhere

## Alert Conditions

Treat these as architecture failures:

- a host-side cron job driving loose plugin calls instead of a timer trigger
- JSON moving between compiled plugins on flow edges
- separate deployment of "scheduler" and "plugins" as different runtime models
- a browser-only JS implementation and a different Go/WASI implementation for
  the same canonical feature
- a claim that a module runs on "any WASI runtime" when it actually needs
  custom imports or a vendor extension
- sidecar metadata or sidecar policy as the only source of runtime truth

## Example Deployment Shape

The following workload is valid in the canonical model:

1. A timer-triggered flow wakes on a declared interval.
2. It fetches OMMs from CelesTrak over an explicit HTTP interface.
3. It writes aligned records through a FlatSQL storage plugin/runtime.
4. It exposes a declared HTTPS interface for download.
5. It publishes content to IPFS and requests pinning through declared host
   services.
6. It notifies peer SDN nodes over a declared SDS protocol binding.
7. It kicks off downstream association and orbit-analysis nodes.

This still compiles to one signed deployable WASM artifact. Local and remote
deployment may wrap that artifact in the same signed and optionally encrypted
deployment envelope.
