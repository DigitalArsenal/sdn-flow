import test from "node:test";
import assert from "node:assert/strict";

import { normalizeSdnFlowEditorInitialFlows } from "../src/editor/flowFormat.js";

test("normalizeSdnFlowEditorInitialFlows preserves embedded editor node config", () => {
  const flows = normalizeSdnFlowEditorInitialFlows({
    programId: "range-flow",
    name: "Range Flow",
    nodes: [
      {
        nodeId: "range-1",
        pluginId: "com.digitalarsenal.editor.range",
        methodId: "invoke",
        kind: "transform",
      },
    ],
    edges: [],
    triggers: [],
    triggerBindings: [],
    editor: {
      nodes: {
        "range-1": {
          x: 180,
          y: 120,
          type: "range",
          config: {
            name: "Scale",
            property: "payload",
            action: "scale",
            minin: "0",
            maxin: "10",
            minout: "0",
            maxout: "100",
            round: true,
          },
        },
      },
    },
  });

  assert.equal(flows.length, 2);
  assert.equal(flows[1].type, "range");
  assert.equal(flows[1].name, "Scale");
  assert.equal(flows[1].x, 180);
  assert.equal(flows[1].y, 120);
  assert.equal(flows[1].property, "payload");
  assert.equal(flows[1].action, "scale");
  assert.equal(flows[1].minin, "0");
  assert.equal(flows[1].maxin, "10");
  assert.equal(flows[1].minout, "0");
  assert.equal(flows[1].maxout, "100");
  assert.equal(flows[1].round, true);
});
