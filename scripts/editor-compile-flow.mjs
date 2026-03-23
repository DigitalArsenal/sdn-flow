#!/usr/bin/env node
import process from "node:process";

import {
  compileNodeRedFlows,
  SdnFlowEditorCompileMode,
} from "../src/editor/compileFlow.js";

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return text;
}

export async function runSdnFlowEditorCompileCli(options = {}) {
  try {
    const raw = await readStdin();
    const payload = raw.trim().length > 0 ? JSON.parse(raw) : {};
    const result = await compileNodeRedFlows(payload?.flows ?? [], {
      ...(payload?.options ?? {}),
      mode:
        payload?.mode ??
        options.mode ??
        SdnFlowEditorCompileMode.PREVIEW,
    });
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    const message =
      typeof error?.stack === "string" && error.stack.trim().length > 0
        ? error.stack
        : String(error?.message ?? error);
    process.stderr.write(message);
    process.exit(1);
  }
}
