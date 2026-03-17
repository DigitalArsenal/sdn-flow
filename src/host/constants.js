export const HostedRuntimeKind = Object.freeze({
  FLOW: "flow",
  PLUGIN: "plugin",
  SERVICE: "service",
});

export const HostedRuntimeAuthority = Object.freeze({
  LOCAL: "local",
  REMOTE: "remote",
});

export const HostedRuntimeStartupPhase = Object.freeze({
  BOOTSTRAP: "bootstrap",
  EARLY: "early",
  SESSION: "session",
  ON_DEMAND: "on-demand",
});

export const HostedRuntimeBindingDirection = Object.freeze({
  LISTEN: "listen",
  DIAL: "dial",
});

export const HostedRuntimeTransport = Object.freeze({
  SAME_APP: "same-app",
  DIRECT: "direct",
  WEBRTC: "webrtc",
  SDN_PROTOCOL: "sdn-protocol",
  HTTP: "http",
});

export const HostedRuntimeAdapter = Object.freeze({
  SDN_JS: "sdn-js",
  HOST_INTERNAL: "host-internal",
  GO_SDN: "go-sdn",
});

export const HostedRuntimeEngine = Object.freeze({
  NODE: "node",
  DENO: "deno",
  BUN: "bun",
  BROWSER: "browser",
  WASI: "wasi",
  GO: "go",
});

export default {
  HostedRuntimeAdapter,
  HostedRuntimeEngine,
  HostedRuntimeAuthority,
  HostedRuntimeBindingDirection,
  HostedRuntimeKind,
  HostedRuntimeStartupPhase,
  HostedRuntimeTransport,
};
