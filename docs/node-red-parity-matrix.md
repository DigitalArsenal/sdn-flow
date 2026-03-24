# Node-RED Default Node Parity Matrix

This matrix is a snapshot of the default shipped node families visible in the
checked-in registry and the current repo implementation state behind them.

Legend:
- `editor-only`: present in the shipped palette/registry, but no runtime
  handler or parity test was found in the current repo scan.
- `JS runtime`: implemented by `src/editor/runtimeManager.js` handlers and
  covered by runtime tests.
- `compiled runtime`: lowered into the compiled artifact/runtime host path.
- `delegated/wrapper`: host-driven trigger or adapter behavior outside the node
  body itself.

Config nodes such as `tls-config`, `mqtt-broker`, and `http proxy` are not
counted here; this matrix covers the runtime node families in the default
palette.

## Matrix

| Family | Target bucket | Current state | Evidence |
| --- | --- | --- | --- |
| `function` | delegated/wrapper | JS runtime | Shipped in `src/editor/nodeRedRegistry.generated.js`; runtime handler in `src/editor/runtimeManager.js`; covered by `test/editor-runtime-manager.test.js`. |
| `change`, `switch`, `range`, `template`, `json`, `csv`, `yaml`, `xml`, `html`, `split`, `join`, `batch`, `sort`, `link in`, `link out`, `link call`, `debug` | standalone `wasi` | JS runtime | Shipped in `src/editor/nodeRedRegistry.generated.js`; runtime handlers in `src/editor/runtimeManager.js`; covered by `test/editor-runtime-nodes.test.js` and `test/editor-runtime-manager.test.js`. |
| `file`, `file in` | standalone `wasi` | JS runtime | Shipped in `src/editor/nodeRedRegistry.generated.js`; runtime handlers in `src/editor/runtimeManager.js`; covered by `test/editor-runtime-manager.test.js`. |
| `rbe` | standalone `wasi` | editor-only | Shipped in `src/editor/nodeRedRegistry.generated.js`; no runtime handler or parity test hit found in the current repo scan. |
| `inject` | standalone `wasi` | delegated/wrapper | Lowered to triggers in `src/editor/flowLowering.js`; host dispatch path in `src/editor/runtimeManager.js`; covered by `test/editor-compile-artifact.test.js` and `test/editor-runtime-manager.test.js`. |
| `http request` | `wasmedge` | JS runtime | Shipped in `src/editor/nodeRedRegistry.generated.js`; `com.digitalarsenal.flow.http-fetcher:fetch` handler in `src/editor/runtimeManager.js`; covered by `test/editor-runtime-manager.test.js`. |
| `http in` | `wasmedge` | delegated/wrapper | Lowered to triggers in `src/editor/flowLowering.js`; request handling in `src/editor/runtimeManager.js`; covered by `test/editor-compile-artifact.test.js` and `test/editor-runtime.test.js`. |
| `http response` | `wasmedge` | JS runtime | Shipped in `src/editor/nodeRedRegistry.generated.js`; `com.digitalarsenal.flow.http-response:send` handler in `src/editor/runtimeManager.js`; covered by `test/editor-runtime-manager.test.js`. |
| `tcp in`, `tcp out`, `tcp request`, `udp in`, `udp out`, `websocket in`, `websocket out`, `websocket-listener`, `websocket-client`, `mqtt in`, `mqtt out` | `wasmedge` | editor-only | Shipped in `src/editor/nodeRedRegistry.generated.js`; no runtime handler or parity test hit found in the current repo scan. |
| `watch`, `catch`, `status`, `complete`, `comment` | delegated/wrapper | editor-only | Shipped in `src/editor/nodeRedRegistry.generated.js`; no runtime handler or parity test hit found in the current repo scan. |
| `delay`, `trigger`, `exec` | delegated/wrapper | JS runtime | Shipped in `src/editor/nodeRedRegistry.generated.js`; runtime handlers in `src/editor/runtimeManager.js`; covered by `test/editor-runtime-manager.test.js`. |

## Notes

- The matrix does not currently show any default node family as `compiled
  runtime`. The compiled artifact path is present in the repo, but the default
  node semantics above are still implemented through JS runtime handlers or
  host delegation.
- `protocol_handle` and `protocol_dial` appear in deployment and host tests,
  but they are not separate default Node-RED palette families in the checked-in
  registry, so they are tracked outside this matrix.
