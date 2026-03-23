#!/usr/bin/env node
import { runSdnFlowEditorCompileCli } from "./editor-compile-flow.mjs";

await runSdnFlowEditorCompileCli({
  mode: "preview",
});
