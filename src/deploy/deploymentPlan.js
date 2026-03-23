import {
  DeploymentBindingMode,
  ScheduleBindingKind,
  normalizeDeploymentPlan,
  validateDeploymentPlan,
} from "space-data-module-sdk";

import { normalizeProgram } from "../runtime/index.js";

function normalizeString(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractNodeIdFromTriggerId(triggerId) {
  const normalized = normalizeString(triggerId, "");
  return normalized.startsWith("trigger-") ? normalized.slice(8) : normalized;
}

function getEditorNodeConfig(program, triggerId) {
  const nodeId = extractNodeIdFromTriggerId(triggerId);
  return program?.editor?.nodes?.[nodeId]?.config ?? {};
}

function parseSecondsToMilliseconds(value) {
  const normalized = Number.parseFloat(String(value ?? "").trim());
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return 0;
  }
  return Math.round(normalized * 1000);
}

function normalizeHttpRoutePath(value) {
  const normalized = normalizeString(value, "/") ?? "/";
  if (normalized === "/") {
    return "/";
  }
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function mergeById(generatedEntries, explicitEntries, idKey) {
  const merged = new Map();
  for (const entry of normalizeArray(generatedEntries)) {
    const identifier = normalizeString(entry?.[idKey], null);
    if (!identifier) {
      continue;
    }
    merged.set(identifier, entry);
  }
  for (const entry of normalizeArray(explicitEntries)) {
    const identifier = normalizeString(entry?.[idKey], null);
    if (!identifier) {
      continue;
    }
    merged.set(identifier, entry);
  }
  return Array.from(merged.values());
}

function createDelegatedServiceUrl(baseUrl, routePath) {
  const normalizedBaseUrl = normalizeString(baseUrl, null);
  if (!normalizedBaseUrl) {
    return null;
  }
  try {
    return new URL(routePath, normalizedBaseUrl).toString();
  } catch {
    return null;
  }
}

function buildGeneratedScheduleBindings(program, options = {}) {
  const defaultBindingMode =
    options.scheduleBindingMode ?? DeploymentBindingMode.LOCAL;
  return normalizeArray(program?.triggers)
    .filter((trigger) => trigger?.kind === "timer")
    .map((trigger) => {
      const config = getEditorNodeConfig(program, trigger.triggerId);
      const cron = normalizeString(config.crontab, null);
      const intervalMs = parseSecondsToMilliseconds(config.repeat);
      const runAtStartup = config.once === true;
      const startupDelayMs = parseSecondsToMilliseconds(config.onceDelay);
      const scheduleKind = cron
        ? ScheduleBindingKind.CRON
        : intervalMs > 0
          ? ScheduleBindingKind.INTERVAL
          : ScheduleBindingKind.ONCE;
      return {
        scheduleId: `schedule-${trigger.triggerId}`,
        bindingMode: defaultBindingMode,
        triggerId: trigger.triggerId,
        scheduleKind,
        cron,
        intervalMs,
        runAtStartup,
        startupDelayMs,
        timezone:
          normalizeString(config.timezone, null) ??
          normalizeString(options.timezone, null),
        description:
          normalizeString(trigger.description, null) ??
          normalizeString(trigger.source, null),
      };
    });
}

function buildGeneratedServiceBindings(program, options = {}) {
  const defaultBindingMode =
    options.serviceBindingMode ?? DeploymentBindingMode.LOCAL;
  const defaultAuthPolicyId = normalizeString(
    options.defaultHttpAuthPolicyId,
    null,
  );
  const delegatedServiceBaseUrl = normalizeString(
    options.delegatedServiceBaseUrl,
    null,
  );
  return normalizeArray(program?.triggers)
    .filter((trigger) => trigger?.kind === "http-request")
    .map((trigger) => {
      const config = getEditorNodeConfig(program, trigger.triggerId);
      const routePath = normalizeHttpRoutePath(config.url ?? trigger.source);
      const method = (
        normalizeString(config.method, "get") ?? "get"
      ).toUpperCase();
      const bindingMode =
        normalizeString(config.bindingMode, null) ?? defaultBindingMode;
      return {
        serviceId: `service-${trigger.triggerId}`,
        bindingMode,
        serviceKind: "http-server",
        triggerId: trigger.triggerId,
        routePath,
        method,
        adapter: normalizeString(options.httpAdapter, null),
        remoteUrl:
          bindingMode === DeploymentBindingMode.DELEGATED
            ? createDelegatedServiceUrl(delegatedServiceBaseUrl, routePath)
            : null,
        allowTransports:
          bindingMode === DeploymentBindingMode.DELEGATED
            ? ["https", "wss"]
            : [],
        authPolicyId: defaultAuthPolicyId,
        description:
          normalizeString(trigger.description, null) ??
          `[${method}] ${routePath}`,
      };
    });
}

export function createFlowDeploymentPlan(program, options = {}) {
  const normalizedProgram = normalizeProgram(program);
  const explicitPlan = normalizeDeploymentPlan(options.deploymentPlan ?? {});
  const plan = normalizeDeploymentPlan({
    formatVersion: explicitPlan.formatVersion ?? 1,
    pluginId:
      explicitPlan.pluginId ??
      normalizeString(options.pluginId, null) ??
      normalizeString(normalizedProgram.programId, null),
    version:
      explicitPlan.version ??
      normalizeString(options.version, null) ??
      normalizeString(normalizedProgram.version, null),
    artifactCid: explicitPlan.artifactCid,
    bundleCid: explicitPlan.bundleCid,
    environmentId:
      explicitPlan.environmentId ??
      normalizeString(options.environmentId, null),
    protocolInstallations: explicitPlan.protocolInstallations,
    inputBindings: explicitPlan.inputBindings,
    scheduleBindings: mergeById(
      buildGeneratedScheduleBindings(normalizedProgram, options),
      explicitPlan.scheduleBindings,
      "scheduleId",
    ),
    serviceBindings: mergeById(
      buildGeneratedServiceBindings(normalizedProgram, options),
      explicitPlan.serviceBindings,
      "serviceId",
    ),
    authPolicies: explicitPlan.authPolicies,
    publicationBindings: explicitPlan.publicationBindings,
  });
  const report = validateDeploymentPlan(plan);
  if (!report.ok) {
    const detail = report.errors
      .map((issue) => `${issue.location ?? "deploymentPlan"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid flow deployment plan:\n${detail}`);
  }
  return report.plan;
}

export default {
  createFlowDeploymentPlan,
};
