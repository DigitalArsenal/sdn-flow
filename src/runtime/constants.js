export const DrainPolicy = Object.freeze({
  SINGLE_SHOT: "single-shot",
  DRAIN_UNTIL_YIELD: "drain-until-yield",
  DRAIN_TO_EMPTY: "drain-to-empty",
});

export const BackpressurePolicy = Object.freeze({
  DROP: "drop",
  LATEST: "latest",
  QUEUE: "queue",
  BLOCK_REQUEST: "block-request",
  COALESCE: "coalesce",
  DRAIN_TO_EMPTY: "drain-to-empty",
});

export const TriggerKind = Object.freeze({
  MANUAL: "manual",
  TIMER: "timer",
  PUBSUB_SUBSCRIPTION: "pubsub-subscription",
  PROTOCOL_REQUEST: "protocol-request",
  HTTP_REQUEST: "http-request",
  ORBPRO_EVENT: "orbpro-event",
  SCENE_EVENT: "scene-event",
  SYSTEM_EVENT: "system-event",
});

export const NodeKind = Object.freeze({
  TRIGGER: "trigger",
  TRANSFORM: "transform",
  ANALYZER: "analyzer",
  PUBLISHER: "publisher",
  RESPONDER: "responder",
  RENDERER: "renderer",
  SINK: "sink",
});

export const DefaultManifestExports = Object.freeze({
  pluginBytesSymbol: "plugin_get_manifest_flatbuffer",
  pluginSizeSymbol: "plugin_get_manifest_flatbuffer_size",
  flowBytesSymbol: "flow_get_manifest_flatbuffer",
  flowSizeSymbol: "flow_get_manifest_flatbuffer_size",
});
