import {
  compileNodeRedFlows,
  runSdnFlowEditorCompileInSubprocess,
  SdnFlowEditorCompileMode,
} from "./compileFlow.js";

export async function compileNodeRedFlowsToSdnArtifact(flows = [], options = {}) {
  return compileNodeRedFlows(flows, {
    ...options,
    mode: SdnFlowEditorCompileMode.ARTIFACT,
  });
}

export async function compileNodeRedFlowsToSdnArtifactInSubprocess(
  flows = [],
  options = {},
) {
  return runSdnFlowEditorCompileInSubprocess(flows, {
    ...options,
    mode: SdnFlowEditorCompileMode.ARTIFACT,
  });
}

export default {
  compileNodeRedFlowsToSdnArtifact,
  compileNodeRedFlowsToSdnArtifactInSubprocess,
};
