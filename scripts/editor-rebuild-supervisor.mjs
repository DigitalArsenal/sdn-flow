import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !isProcessAlive(pid);
}

async function archiveExecutable(request) {
  const sourcePath =
    normalizeString(request.currentExecutablePath, null) ??
    normalizeString(request.targetExecutablePath, null);
  if (!sourcePath || !(await pathExists(sourcePath))) {
    return null;
  }

  await fs.mkdir(request.archiveDir, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const archiveName = `${path.basename(sourcePath, path.extname(sourcePath))}-${timestamp}${path.extname(sourcePath)}`;
  const archivePath = path.join(request.archiveDir, archiveName);
  await fs.rename(sourcePath, archivePath);
  return archivePath;
}

async function replaceExecutable(request) {
  if (!(await pathExists(request.stagingExecutablePath))) {
    throw new Error(`Staging executable not found at ${request.stagingExecutablePath}`);
  }
  await fs.mkdir(path.dirname(request.targetExecutablePath), { recursive: true });
  if (await pathExists(request.targetExecutablePath)) {
    await fs.rm(request.targetExecutablePath, { force: true });
  }
  await fs.rename(request.stagingExecutablePath, request.targetExecutablePath);
}

function launchExecutable(request) {
  const child = spawn(request.targetExecutablePath, request.launchArgs ?? [], {
    cwd: request.projectRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function main() {
  const requestPath = normalizeString(process.argv[2], null);
  if (!requestPath) {
    throw new Error("Usage: node scripts/editor-rebuild-supervisor.mjs <request.json>");
  }

  const request = await readJson(path.resolve(requestPath));
  await fs.mkdir(path.dirname(request.stagingExecutablePath), { recursive: true });
  if (await pathExists(request.stagingExecutablePath)) {
    await fs.rm(request.stagingExecutablePath, { force: true });
  }

  await runCommand(
    request.npmCommand ?? "npm",
    [
      "run",
      "build:editor-executable",
      "--",
      "--output",
      request.stagingExecutablePath,
    ],
    {
      cwd: request.projectRoot,
      stdio: "ignore",
    },
  );

  const currentPid = Number.parseInt(String(request.currentPid ?? 0), 10);
  if (currentPid > 0 && isProcessAlive(currentPid)) {
    process.kill(currentPid, "SIGTERM");
    await waitForExit(currentPid);
  }

  await archiveExecutable(request);
  await replaceExecutable(request);
  launchExecutable(request);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
}
