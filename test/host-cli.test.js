import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  formatSdnFlowHostUsage,
  parseSdnFlowHostCliArgs,
  runSdnFlowHostCli,
} from "../bin/sdn-flow-host.js";

test("parseSdnFlowHostCliArgs supports workspace, engine, and help flags", () => {
  assert.deepEqual(
    parseSdnFlowHostCliArgs([
      "--workspace",
      "./workspace.json",
      "--engine",
      "node",
    ]),
    {
      workspacePath: "./workspace.json",
      engine: "node",
      help: false,
    },
  );

  assert.deepEqual(parseSdnFlowHostCliArgs(["-h"]), {
    workspacePath: null,
    engine: null,
    help: true,
  });
});

test("formatSdnFlowHostUsage documents the workspace option", () => {
  assert.match(formatSdnFlowHostUsage(), /--workspace <workspace\.json>/);
  assert.match(formatSdnFlowHostUsage(), /--engine <engine>/);
});

test("runSdnFlowHostCli starts the auto host with the resolved workspace path", async () => {
  const logs = [];
  const startCalls = [];
  const result = await runSdnFlowHostCli(
    ["--workspace", "./examples/environments/sdn-js-catalog-gateway/workspace.json", "--engine", "node"],
    {
      log(message) {
        logs.push(message);
      },
      registerSignalHandlers: false,
      startInstalledFlowAutoHost: async (options) => {
        startCalls.push(options);
        return {
          startup: {
            workspace: {
              workspaceId: "sdn-js-catalog-gateway",
              programId:
                "com.digitalarsenal.examples.sdn-js-catalog-gateway",
              engine: "node",
            },
          },
          listeners: [
            {
              close() {},
            },
          ],
          async stop() {},
        };
      },
    },
  );

  assert.equal(result.kind, "started");
  assert.equal(startCalls.length, 1);
  assert.equal(
    startCalls[0].workspacePath,
    path.resolve("./examples/environments/sdn-js-catalog-gateway/workspace.json"),
  );
  assert.equal(startCalls[0].engine, "node");
  assert.match(logs[0], /Started sdn-js-catalog-gateway \(node\)/);
  assert.match(logs[0], /with 1 listener/);
});

test("runSdnFlowHostCli prints help without starting the host", async () => {
  const logs = [];
  const result = await runSdnFlowHostCli(["--help"], {
    log(message) {
      logs.push(message);
    },
    startInstalledFlowAutoHost() {
      throw new Error("help should not start the host");
    },
  });

  assert.equal(result.kind, "help");
  assert.match(logs[0], /Usage: sdn-flow-host/);
});
