import {
  compileNodeRedFlows,
  runSdnFlowEditorCompileInSubprocess,
  SdnFlowEditorCompileMode,
} from "./compileFlow.js";
import { convertNodeRedFlowsToSdnProgram } from "./flowLowering.js";

export { convertNodeRedFlowsToSdnProgram };

export async function createSdnFlowEditorCompilePreview(flows = [], options = {}) {
  return compileNodeRedFlows(flows, {
    ...options,
    mode: SdnFlowEditorCompileMode.PREVIEW,
  });
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
  convertNodeRedFlowsToSdnProgram,
  createSdnFlowEditorCompilePreview,
  createSdnFlowEditorCompilePreviewInSubprocess,
};
