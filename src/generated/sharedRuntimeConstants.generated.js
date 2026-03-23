// Auto-generated from space-data-module-sdk/runtime - DO NOT EDIT.

export const DrainPolicy = Object.freeze({
  "SINGLE_SHOT": "single-shot",
  "DRAIN_UNTIL_YIELD": "drain-until-yield",
  "DRAIN_TO_EMPTY": "drain-to-empty"
});

export const ExternalInterfaceDirection = Object.freeze({
  "INPUT": "input",
  "OUTPUT": "output",
  "BIDIRECTIONAL": "bidirectional"
});

export const ExternalInterfaceKind = Object.freeze({
  "CLOCK": "clock",
  "RANDOM": "random",
  "TIMER": "timer",
  "SCHEDULE": "schedule",
  "PUBSUB": "pubsub",
  "PROTOCOL": "protocol",
  "HTTP": "http",
  "WEBSOCKET": "websocket",
  "MQTT": "mqtt",
  "TCP": "tcp",
  "UDP": "udp",
  "TLS": "tls",
  "FILESYSTEM": "filesystem",
  "PIPE": "pipe",
  "NETWORK": "network",
  "DATABASE": "database",
  "EXEC": "exec",
  "CRYPTO": "crypto",
  "CONTEXT": "context",
  "LOCAL_RUNTIME": "local-runtime",
  "HOST_SERVICE": "host-service"
});

export const RuntimeTarget = Object.freeze({
  "NODE": "node",
  "BROWSER": "browser",
  "WASI": "wasi",
  "WASMEDGE": "wasmedge",
  "SERVER": "server",
  "DESKTOP": "desktop",
  "EDGE": "edge"
});

export const InvokeSurface = Object.freeze({
  "DIRECT": "direct",
  "COMMAND": "command"
});

export const DefaultManifestExports = Object.freeze({
  "pluginBytesSymbol": "plugin_get_manifest_flatbuffer",
  "pluginSizeSymbol": "plugin_get_manifest_flatbuffer_size",
  "flowBytesSymbol": "flow_get_manifest_flatbuffer",
  "flowSizeSymbol": "flow_get_manifest_flatbuffer_size"
});

export const DefaultInvokeExports = Object.freeze({
  "invokeSymbol": "plugin_invoke_stream",
  "allocSymbol": "plugin_alloc",
  "freeSymbol": "plugin_free",
  "commandSymbol": "_start"
});

export default {
  DrainPolicy,
  ExternalInterfaceDirection,
  ExternalInterfaceKind,
  RuntimeTarget,
  InvokeSurface,
  DefaultManifestExports,
  DefaultInvokeExports,
};
