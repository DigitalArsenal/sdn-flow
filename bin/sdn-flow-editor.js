#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { startSdnFlowEditorNodeHost } from "../src/editor/index.js";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizePort(value, fallback = 8080) {
  const port = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

export function formatSdnFlowEditorUsage() {
  return [
    "Usage: sdn-flow-editor [--host <hostname>] [--port <port>] [--base-path <path>] [--flow <flow.json>]",
    "",
    "Options:",
    "  --host <hostname>      Hostname to bind. Default: 127.0.0.1",
    "  --port <port>          Port to bind. Default: 8080",
    "  --base-path <path>     Optional mount path, such as /editor.",
    "  --flow <flow.json>     Optional initial flow JSON to load in the editor.",
    "  --title <title>        Optional window title shown in the editor.",
    "  -h, --help             Show this help text.",
  ].join("\n");
}

export function parseSdnFlowEditorCliArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed = {
    hostname: "127.0.0.1",
    port: 8080,
    basePath: "/",
    flowPath: null,
    title: null,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    switch (token) {
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      case "--host":
        parsed.hostname = normalizeString(args[index + 1], parsed.hostname);
        index += 1;
        break;
      case "--port":
        parsed.port = normalizePort(args[index + 1], parsed.port);
        index += 1;
        break;
      case "--base-path":
        parsed.basePath = normalizeString(args[index + 1], parsed.basePath);
        index += 1;
        break;
      case "--flow":
        parsed.flowPath = normalizeString(args[index + 1], null);
        index += 1;
        break;
      case "--title":
        parsed.title = normalizeString(args[index + 1], null);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return parsed;
}

async function readInitialFlow(flowPath) {
  if (!flowPath) {
    return null;
  }
  const resolvedPath = path.resolve(flowPath);
  const json = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
  return {
    resolvedPath,
    json,
  };
}

function installShutdownHooks(host, options = {}) {
  if (
    options.registerSignalHandlers === false ||
    typeof host?.close !== "function" ||
    typeof process.on !== "function"
  ) {
    return;
  }

  let closing = false;
  const closeHost = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await host.close();
    if (options.exitProcess !== false) {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void closeHost();
  });
  process.on("SIGTERM", () => {
    void closeHost();
  });
}

export async function runSdnFlowEditorCli(argv = process.argv.slice(2), options = {}) {
  const parsed = parseSdnFlowEditorCliArgs(argv);
  const log = options.log ?? console.log.bind(console);

  if (parsed.help) {
    log(formatSdnFlowEditorUsage());
    return {
      kind: "help",
      args: parsed,
    };
  }

  const initialFlow = await readInitialFlow(parsed.flowPath);
  const startEditorHost =
    options.startEditorHost ?? startSdnFlowEditorNodeHost;
  const host = await startEditorHost({
    hostname: parsed.hostname,
    port: parsed.port,
    basePath: parsed.basePath,
    title: parsed.title ?? "sdn-flow Editor",
    initialFlow: initialFlow?.json ?? null,
  });

  if (options.quiet !== true) {
    log(`Started sdn-flow editor at ${host.url}`);
  }

  installShutdownHooks(host, options);

  return {
    kind: "started",
    args: {
      ...parsed,
      flowPath: initialFlow?.resolvedPath ?? parsed.flowPath,
    },
    host,
  };
}

if (import.meta.main) {
  try {
    await runSdnFlowEditorCli();
  } catch (error) {
    console.error(
      typeof error?.message === "string" ? error.message : String(error),
    );
    console.error("");
    console.error(formatSdnFlowEditorUsage());
    process.exit(1);
  }
}
