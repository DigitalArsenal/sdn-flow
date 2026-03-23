import path from "node:path";

import { createSharedEmceptionSession } from "space-data-module-sdk/compiler/emception";

function normalizePosixPath(filePath) {
  return path.posix.normalize(String(filePath ?? "").replaceAll("\\", "/"));
}

export async function createSdkEmceptionSession(options = {}) {
  const workDir = normalizePosixPath(
    options.workDir ?? options.workingDirectory ?? "/working",
  );
  const sharedSession = createSharedEmceptionSession();

  return {
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

export default createSdkEmceptionSession;
