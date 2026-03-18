import { startSdnFlowEditorDenoHost } from "../src/editor/denoHost.js";

type ParsedArgs = {
  hostname: string;
  port: number;
  basePath: string;
  flowPath: string | null;
  title: string | null;
  help: boolean;
};

function normalizeString(value: string | undefined, fallback: string | null = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizePort(value: string | undefined, fallback = 8080) {
  const port = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(port) && port >= 0 ? port : fallback;
}

export function formatSdnFlowEditorDenoUsage() {
  return [
    "Usage: deno run --allow-net --allow-read ./tools/sdn-flow-editor.ts [--host <hostname>] [--port <port>] [--base-path <path>] [--flow <flow.json>]",
    "",
    "Compile to one executable:",
    "  deno compile --allow-net --allow-read --output sdn-flow-editor ./tools/sdn-flow-editor.ts",
  ].join("\n");
}

export function parseSdnFlowEditorDenoArgs(argv: string[] = []): ParsedArgs {
  const args = Array.isArray(argv) ? [...argv] : [];
  const parsed: ParsedArgs = {
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
  return JSON.parse(text);
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

  const initialFlow = await loadInitialFlow(parsed.flowPath);
  const host = await startSdnFlowEditorDenoHost({
    hostname: parsed.hostname,
    port: parsed.port,
    basePath: parsed.basePath,
    title: parsed.title ?? "sdn-flow Editor",
    initialFlow,
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
