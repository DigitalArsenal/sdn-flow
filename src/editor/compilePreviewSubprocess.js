import {
  resolveSdnFlowEditorCompileScriptPath,
  runSdnFlowEditorCompileInSubprocess,
  SdnFlowEditorCompileMode,
} from "./compileFlow.js";

export function resolveSdnFlowEditorCompilePreviewScriptPath(options = {}) {
  return resolveSdnFlowEditorCompileScriptPath(
    SdnFlowEditorCompileMode.PREVIEW,
    options,
  );
}

export async function createSdnFlowEditorCompilePreviewInSubprocess(
  flows = [],
  options = {},
) {
  return runSdnFlowEditorCompileInSubprocess(flows, {
    ...options,
    mode: SdnFlowEditorCompileMode.PREVIEW,
  });
}

export default {
  createSdnFlowEditorCompilePreviewInSubprocess,
  resolveSdnFlowEditorCompilePreviewScriptPath,
};
