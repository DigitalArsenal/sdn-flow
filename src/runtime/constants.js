import {
  DefaultManifestExports as SharedDefaultManifestExports,
  DrainPolicy as SharedDrainPolicy,
  ExternalInterfaceDirection as SharedExternalInterfaceDirection,
  ExternalInterfaceKind as SharedExternalInterfaceKind,
  RuntimeTarget as SharedRuntimeTarget,
} from "space-data-module-sdk";

export const DrainPolicy = SharedDrainPolicy;

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

export const ExternalInterfaceDirection = SharedExternalInterfaceDirection;
export const ExternalInterfaceKind = SharedExternalInterfaceKind;
export const RuntimeTarget = SharedRuntimeTarget;
export const DefaultManifestExports = SharedDefaultManifestExports;
