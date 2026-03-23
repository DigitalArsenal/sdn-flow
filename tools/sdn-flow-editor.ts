import { startSdnFlowEditorDenoHost } from "../src/editor/denoHost.js";
import { normalizeSdnFlowEditorInitialFlows } from "../src/editor/flowFormat.js";
import {
  getSdnFlowEditorRuntimePaths,
  isLegacyDefaultSdnFlowEditorStartup,
  migrateLegacyDefaultSdnFlowEditorStartup,
  readSdnFlowEditorSettingsFile,
  readSdnFlowEditorSessionFile,
  writeSdnFlowEditorSettingsFile,
  writeSdnFlowEditorSessionFile,
} from "../src/editor/runtimeManager.js";
import path from "node:path";

type ParsedArgs = {
  hostname: string;
  port: number;
  basePath: string;
  flowPath: string | null;
  sessionFile: string | null;
  title: string | null;
  help: boolean;
};

type StartupSettings = {
  hostname: string;
  port: number;
  basePath: string;
  title: string;
};

const DEFAULT_HOSTNAME = "127.0.0.1";
const DEFAULT_PORT = 1990;
const DEFAULT_BASE_PATH = "/";

function normalizeString(value: string | undefined, fallback: string | null = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizePort(value: string | undefined, fallback = 1990) {
  const port = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

export function formatSdnFlowEditorDenoUsage() {
  return [
    "Usage: deno run --allow-net --allow-read --allow-write --allow-run --allow-env --allow-sys ./tools/sdn-flow-editor.ts [--host <hostname>] [--port <port>] [--base-path <path>] [--flow <flow.json>] [--session-file <session.json>]",
    "",
    "Compile to one executable:",
    "  deno compile --allow-net --allow-read --allow-write --allow-run --allow-env --allow-sys --output sdn-flow-editor ./tools/sdn-flow-editor.ts",
  ].join("\n");
}

export function parseSdnFlowEditorDenoArgs(argv: string[] = []): ParsedArgs {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed: ParsedArgs = {
    hostname: "127.0.0.1",
    port: DEFAULT_PORT,
    basePath: DEFAULT_BASE_PATH,
    flowPath: null,
    sessionFile: null,
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
        parsed.hostname = normalizeString(args[index + 1], parsed.hostname) ?? parsed.hostname;
        index += 1;
        break;
      case "--port":
        parsed.port = normalizePort(args[index + 1], parsed.port);
        index += 1;
        break;
      case "--base-path":
        parsed.basePath = normalizeString(args[index + 1], parsed.basePath) ?? parsed.basePath;
        index += 1;
        break;
      case "--flow":
        parsed.flowPath = normalizeString(args[index + 1], null);
        index += 1;
        break;
      case "--session-file":
        parsed.sessionFile = normalizeString(args[index + 1], null);
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

async function loadInitialFlow(flowPath: string | null) {
  if (!flowPath) {
    return null;
  }
  const text = await Deno.readTextFile(flowPath);
  return normalizeSdnFlowEditorInitialFlows(JSON.parse(text));
}

async function loadSessionFile(sessionFile: string | null) {
  if (!sessionFile) {
    return null;
  }
  return readSdnFlowEditorSessionFile(sessionFile);
}

async function loadRuntimeSettingsFile(projectRoot: string) {
  const { settingsFilePath } = getSdnFlowEditorRuntimePaths({ projectRoot });
  try {
    return await readSdnFlowEditorSettingsFile(settingsFilePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : null;
    const name =
      error && typeof error === "object" && "name" in error ? error.name : null;
    const message =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : String(error ?? "");
    if (code === "ENOENT" || name === "NotFound" || /ENOENT|NotFound/i.test(message)) {
      return null;
    }
    throw error;
  }
}

function resolveStartupValue<T>(
  parsedValue: T,
  defaultValue: T,
  sessionValue: T | undefined | null,
  persistedValue: T | undefined | null,
) {
  if (sessionValue !== undefined && sessionValue !== null) {
    return parsedValue === defaultValue ? sessionValue : parsedValue;
  }
  if (persistedValue !== undefined && persistedValue !== null) {
    return parsedValue === defaultValue ? persistedValue : parsedValue;
  }
  return parsedValue;
}

export function resolveSdnFlowEditorDenoProjectRoot(execPath = Deno.execPath()) {
  const executablePath = path.resolve(execPath);
  const executableName = path.basename(executablePath);
  if (executableName.startsWith("sdn-flow-editor")) {
    return path.resolve(path.dirname(executablePath), "..");
  }
  return path.resolve(new URL("..", import.meta.url).pathname);
}

export async function startSdnFlowEditorDenoCli(argv: string[] = Deno.args) {
  const parsed = parseSdnFlowEditorDenoArgs(argv);
  if (parsed.help) {
    console.log(formatSdnFlowEditorDenoUsage());
    return {
      kind: "help",
      args: parsed,
    };
  }

  const projectRoot = resolveSdnFlowEditorDenoProjectRoot();
  const session = await loadSessionFile(parsed.sessionFile);
  const migratedSessionStartup: StartupSettings | null = session?.startup
    ? migrateLegacyDefaultSdnFlowEditorStartup(session.startup)
    : null;
  if (session?.startup && isLegacyDefaultSdnFlowEditorStartup(session.startup) && parsed.sessionFile) {
    session.startup = migratedSessionStartup;
    await writeSdnFlowEditorSessionFile(parsed.sessionFile, session);
  }
  const runtimeSettingsFile = session ? null : await loadRuntimeSettingsFile(projectRoot);
  const initialFlow = await loadInitialFlow(parsed.flowPath);
  const persistedStartup: Partial<StartupSettings> = runtimeSettingsFile?.startup
    ? migrateLegacyDefaultSdnFlowEditorStartup(runtimeSettingsFile.startup)
    : {};
  if (
    runtimeSettingsFile?.startup &&
    isLegacyDefaultSdnFlowEditorStartup(runtimeSettingsFile.startup)
  ) {
    const { settingsFilePath } = getSdnFlowEditorRuntimePaths({ projectRoot });
    runtimeSettingsFile.startup = persistedStartup;
    await writeSdnFlowEditorSettingsFile(settingsFilePath, runtimeSettingsFile);
  }
  const hostname = resolveStartupValue(
    parsed.hostname,
    DEFAULT_HOSTNAME,
    migratedSessionStartup?.hostname,
    persistedStartup.hostname,
  );
  const port = resolveStartupValue(
    parsed.port,
    DEFAULT_PORT,
    migratedSessionStartup?.port,
    persistedStartup.port,
  );
  const basePath = resolveStartupValue(
    parsed.basePath,
    DEFAULT_BASE_PATH,
    migratedSessionStartup?.basePath,
    persistedStartup.basePath,
  );
  const title =
    resolveStartupValue(
      parsed.title,
      null,
      migratedSessionStartup?.title,
      persistedStartup.title,
    ) ?? "sdn-flow Editor";
  const host = await startSdnFlowEditorDenoHost({
    projectRoot,
    hostname,
    port,
    basePath,
    title,
    initialFlow: session?.flows ?? initialFlow,
  });

  console.log(`Started sdn-flow editor at ${host.url}`);
  return {
    kind: "started",
    args: parsed,
    host,
  };
}

if (import.meta.main) {
  try {
    await startSdnFlowEditorDenoCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    console.error(formatSdnFlowEditorDenoUsage());
    Deno.exit(1);
  }
}
