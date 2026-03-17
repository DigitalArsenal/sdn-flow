#!/usr/bin/env node
import path from "node:path";
import process from "node:process";

import { startInstalledFlowAutoHost } from "../src/index.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

export function formatSdnFlowHostUsage() {
  return [
    "Usage: sdn-flow-host --workspace <workspace.json> [--engine <engine>]",
    "",
    "Options:",
    "  -w, --workspace <path>   Path to the installed-flow workspace.json file.",
    "  -e, --engine <engine>    Optional runtime override: node, deno, bun, browser.",
    "  -h, --help               Show this help text.",
  ].join("\n");
}

export function parseSdnFlowHostCliArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let workspacePath = null;
  let engine = null;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-h" || token === "--help") {
      help = true;
      continue;
    }
    if (token === "-w" || token === "--workspace") {
      workspacePath = normalizeString(args[index + 1], null);
      index += 1;
      continue;
    }
    if (token === "-e" || token === "--engine") {
      engine = normalizeString(args[index + 1], null);
      index += 1;
      continue;
    }
    if (!token.startsWith("-") && workspacePath === null) {
      workspacePath = normalizeString(token, null);
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    workspacePath,
    engine,
    help,
  };
}

function summarizeStartedHost(host) {
  const startupSummary = host?.startup?.workspace ?? null;
  const listenerCount = Array.isArray(host?.listeners)
    ? host.listeners.length
    : Array.isArray(host?.bindingContexts)
      ? host.bindingContexts.length
      : 0;

  return {
    workspaceId:
      startupSummary?.workspaceId ?? host?.app?.getSummary?.().workspaceId ?? null,
    programId:
      startupSummary?.programId ?? host?.app?.getSummary?.().programId ?? null,
    engine: startupSummary?.engine ?? host?.app?.getSummary?.().engine ?? null,
    listenerCount,
  };
}

function installShutdownHooks(host, options = {}) {
  if (
    options.registerSignalHandlers === false ||
    typeof host?.stop !== "function" ||
    typeof process.on !== "function"
  ) {
    return;
  }

  let stopping = false;
  const stopHost = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await host.stop();
    if (options.exitProcess !== false) {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void stopHost();
  });
  process.on("SIGTERM", () => {
    void stopHost();
  });
}

export async function runSdnFlowHostCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseSdnFlowHostCliArgs(argv);
  const log = options.log ?? console.log.bind(console);

  if (parsed.help) {
    log(formatSdnFlowHostUsage());
    return {
      kind: "help",
      args: parsed,
    };
  }

  if (!parsed.workspacePath) {
    throw new Error("sdn-flow-host requires --workspace <workspace.json>.");
  }

  const resolvedWorkspacePath = path.resolve(parsed.workspacePath);
  const host = await (
    options.startInstalledFlowAutoHost ?? startInstalledFlowAutoHost
  )({
    ...options.startOptions,
    workspacePath: resolvedWorkspacePath,
    ...(parsed.engine ? { engine: parsed.engine } : {}),
  });
  const summary = summarizeStartedHost(host);

  if (options.quiet !== true) {
    log(
      `Started ${summary.workspaceId ?? "installed-flow workspace"} (${summary.engine ?? "unknown"}) from ${resolvedWorkspacePath}${
        summary.listenerCount > 0
          ? ` with ${summary.listenerCount} listener${summary.listenerCount === 1 ? "" : "s"}`
          : ""
      }.`,
    );
  }

  installShutdownHooks(host, options);

  return {
    kind: "started",
    args: {
      ...parsed,
      workspacePath: resolvedWorkspacePath,
    },
    host,
    summary,
  };
}

if (import.meta.main) {
  try {
    await runSdnFlowHostCli();
  } catch (error) {
    console.error(
      typeof error?.message === "string" ? error.message : String(error),
    );
    console.error("");
    console.error(formatSdnFlowHostUsage());
    process.exit(1);
  }
}
