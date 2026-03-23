import {
  resolveSdnFlowEditorCompileScriptPath,
  runSdnFlowEditorCompileInSubprocess,
  SdnFlowEditorCompileMode,
} from "./compileFlow.js";

export function resolveSdnFlowEditorCompileArtifactScriptPath(options = {}) {
  return resolveSdnFlowEditorCompileScriptPath(
    SdnFlowEditorCompileMode.ARTIFACT,
    options,
  );
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
  compileNodeRedFlowsToSdnArtifactInSubprocess,
  resolveSdnFlowEditorCompileArtifactScriptPath,
};
