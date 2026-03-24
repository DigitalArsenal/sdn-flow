import path from "node:path";

import { createSharedEmceptionSession } from "space-data-module-sdk/compiler/emception";

export const SDK_EMCEPTION_SESSION_KIND =
  "space-data-module-sdk.compiler.emception-session";
const SDK_EMCEPTION_SESSION_TOKEN = Symbol("sdn-flow.sdk-emception-session");

function normalizePosixPath(filePath) {
  return path.posix.normalize(String(filePath ?? "").replaceAll("\\", "/"));
}

export async function createSdkEmceptionSession(options = {}) {
  const workDir = normalizePosixPath(
    options.workDir ?? options.workingDirectory ?? "/working",
  );
  const sharedSession = createSharedEmceptionSession();

  return {
    [SDK_EMCEPTION_SESSION_TOKEN]: true,
    sessionKind: SDK_EMCEPTION_SESSION_KIND,
    workDir,
    async init() {
      await sharedSession.mkdirTree(workDir);
    },
    async writeFile(filePath, content) {
      await sharedSession.writeFile(normalizePosixPath(filePath), content);
    },
    async readFile(filePath, readOptions = {}) {
      return sharedSession.readFile(normalizePosixPath(filePath), readOptions);
    },
    async run(command) {
      const result = await sharedSession.run(command, {
        throwOnNonZero: false,
      });
      return {
        returncode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
    async removeDirectory(directoryPath = workDir) {
      await sharedSession.removeTree(normalizePosixPath(directoryPath));
    },
    async dispose() {},
  };
}

export function isSdkEmceptionSession(session) {
  return (
    Boolean(session) &&
    session[SDK_EMCEPTION_SESSION_TOKEN] === true &&
    session.sessionKind === SDK_EMCEPTION_SESSION_KIND &&
    typeof session.writeFile === "function" &&
    typeof session.readFile === "function" &&
    typeof session.run === "function"
  );
}

export default createSdkEmceptionSession;
