# WasmEdge-Like Wrappers

`sdn-flow` treats the WasmEdge guest ABI as the canonical standalone contract
for fully linked flow artifacts. A runtime should either:

- embed WasmEdge directly
- call the WasmEdge C API directly through native interop
- or use a thin wrapper that emulates the same guest ABI over its native
  WebAssembly engine

## Direct WasmEdge Hosts

These targets do not get wrappers from this package:

- `c`
- `c++`
- `go`
- `java`
- `node`
- `python`
- `rust`

These are also direct, but through a lower-level interop layer instead of a
dedicated wrapper package:

- `kotlin` via the JVM and the Java SDK
- `csharp` via native interop on the WasmEdge C API
- `swift` via Swift C interop on the WasmEdge C API

## Installable Wrappers

Only these targets ship thin installable wrappers from `sdn-flow`:

- `sdn-flow/wrappers/browser`
- `sdn-flow/wrappers/bun`
- `sdn-flow/wrappers/deno`

Each wrapper delegates to the same standalone compiled-flow runtime contract and
keeps the guest ABI WasmEdge-like. The wrapper does not own business logic, and
it does not introduce a second runtime model.
