import test from "node:test";
import assert from "node:assert/strict";

import {
  applySdnFlowEditorBatchNodeMessage,
  applySdnFlowEditorChangeNodeMessage,
  applySdnFlowEditorCsvNodeMessage,
  applySdnFlowEditorHtmlNodeMessage,
  applySdnFlowEditorJsonNodeMessage,
  applySdnFlowEditorJoinNodeMessage,
  applySdnFlowEditorRangeNodeMessage,
  applySdnFlowEditorSortNodeMessage,
  applySdnFlowEditorSplitNodeMessage,
  applySdnFlowEditorTemplateNodeMessage,
  applySdnFlowEditorXmlNodeMessage,
  applySdnFlowEditorYamlNodeMessage,
} from "../src/editor/runtimeManager.js";

test("change node rules apply set/change/move/delete and context-backed values", () => {
  const flow = new Map([
    ["greeting", "hola"],
  ]);
  const global = new Map();

  const output = applySdnFlowEditorChangeNodeMessage(
    {
      rules: [
        { t: "set", p: "count", pt: "msg", to: "42", tot: "num" },
        { t: "set", p: "greeting", pt: "msg", to: "greeting", tot: "flow" },
        { t: "change", p: "payload", pt: "msg", from: "world", fromt: "str", to: "universe", tot: "str" },
        { t: "move", p: "topic", pt: "msg", to: "metadata.topic", tot: "msg" },
        { t: "delete", p: "unused", pt: "msg" },
        { t: "set", p: "featureFlag", pt: "global", to: "true", tot: "bool" },
      ],
    },
    {
      payload: "hello world",
      topic: "demo",
      unused: "drop-me",
    },
    {
      flow,
      global,
      env: {},
    },
  );

  assert.equal(output.payload, "hello universe");
  assert.equal(output.count, 42);
  assert.equal(output.greeting, "hola");
  assert.equal(output.topic, undefined);
  assert.equal(output.metadata.topic, "demo");
  assert.equal("unused" in output, false);
  assert.equal(global.get("featureFlag"), true);
});

test("change node can set flow and global values from the message", () => {
  const flow = new Map();
  const global = new Map();

  const output = applySdnFlowEditorChangeNodeMessage(
    {
      rules: [
        { t: "set", p: "flowGreeting", pt: "flow", to: "payload", tot: "msg" },
        { t: "set", p: "globalGreeting", pt: "global", to: "payload", tot: "msg" },
      ],
    },
    {
      payload: "hello",
    },
    {
      flow,
      global,
      env: {},
    },
  );

  assert.equal(output.payload, "hello");
  assert.equal(flow.get("flowGreeting"), "hello");
  assert.equal(global.get("globalGreeting"), "hello");
});

test("json node parses string payloads into objects", () => {
  const output = applySdnFlowEditorJsonNodeMessage(
    {
      action: "obj",
      property: "payload",
    },
    {
      payload: "{\"value\":42}",
    },
  );

  assert.deepEqual(output, {
    payload: {
      value: 42,
    },
  });
});

test("json node stringifies objects with pretty formatting when requested", () => {
  const output = applySdnFlowEditorJsonNodeMessage(
    {
      action: "str",
      property: "payload",
      pretty: true,
    },
    {
      payload: {
        value: 42,
      },
    },
  );

  assert.equal(
    output.payload,
    JSON.stringify(
      {
        value: 42,
      },
      null,
      4,
    ),
  );
});

test("template node renders mustache against message, env, and flow/global context", () => {
  const flow = new Map([
    ["greeting", "hola"],
  ]);
  const global = new Map([
    ["planet", "earth"],
  ]);

  const output = applySdnFlowEditorTemplateNodeMessage(
    {
      field: "payload",
      fieldType: "msg",
      syntax: "mustache",
      template: "Hello {{name}} from {{flow.greeting}} on {{global.planet}} via {{env.RUNTIME_NAME}}",
      output: "str",
    },
    {
      name: "Ada",
    },
    {
      env: {
        RUNTIME_NAME: "sdn-flow",
      },
      flow,
      global,
    },
  );

  assert.equal(output.payload, "Hello Ada from hola on earth via sdn-flow");
});

test("template node can parse json output and store it in flow context", () => {
  const flow = new Map();

  const output = applySdnFlowEditorTemplateNodeMessage(
    {
      field: "compiled",
      fieldType: "flow",
      syntax: "mustache",
      template: "{\"name\":\"{{payload.name}}\",\"count\":{{payload.count}}}",
      output: "json",
    },
    {
      payload: {
        name: "Ada",
        count: 3,
      },
    },
    {
      env: {},
      flow,
      global: new Map(),
    },
  );

  assert.deepEqual(output.payload, { name: "Ada", count: 3 });
  assert.deepEqual(flow.get("compiled"), { name: "Ada", count: 3 });
});

test("range node scales, clamps, drops, and rolls values like the Node-RED core node", () => {
  assert.deepEqual(
    applySdnFlowEditorRangeNodeMessage(
      {
        property: "payload",
        action: "scale",
        minin: "0",
        maxin: "10",
        minout: "0",
        maxout: "100",
      },
      {
        payload: 5,
      },
    ),
    {
      payload: 50,
    },
  );

  assert.deepEqual(
    applySdnFlowEditorRangeNodeMessage(
      {
        property: "payload",
        action: "clamp",
        minin: "0",
        maxin: "10",
        minout: "0",
        maxout: "100",
      },
      {
        payload: 20,
      },
    ),
    {
      payload: 100,
    },
  );

  assert.equal(
    applySdnFlowEditorRangeNodeMessage(
      {
        property: "payload",
        action: "drop",
        minin: "0",
        maxin: "10",
        minout: "0",
        maxout: "100",
      },
      {
        payload: 20,
      },
    ),
    null,
  );

  assert.deepEqual(
    applySdnFlowEditorRangeNodeMessage(
      {
        property: "payload",
        action: "roll",
        minin: "0",
        maxin: "10",
        minout: "0",
        maxout: "100",
        round: true,
      },
      {
        payload: 12,
      },
    ),
    {
      payload: 20,
    },
  );
});

test("sort node orders message array payloads by element property", () => {
  const output = applySdnFlowEditorSortNodeMessage(
    {
      target: "payload",
      targetType: "msg",
      msgKey: "score",
      msgKeyType: "elem",
      order: "ascending",
      as_num: true,
    },
    {
      payload: [
        { score: "10", name: "ten" },
        { score: "2", name: "two" },
        { score: "30", name: "thirty" },
      ],
    },
  );

  assert.deepEqual(output.payload.map((entry) => entry.name), ["two", "ten", "thirty"]);
});

test("sort node reorders sequences and rewrites msg.parts.index", () => {
  const state = {
    groups: new Map(),
    pendingSequence: 0,
  };

  const first = applySdnFlowEditorSortNodeMessage(
    {
      targetType: "seq",
      seqKey: "payload.order",
      seqKeyType: "msg",
      order: "ascending",
      as_num: true,
    },
    {
      payload: { order: 20, name: "later" },
      parts: {
        id: "seq-1",
        index: 0,
        count: 2,
      },
    },
    { state },
  );
  assert.equal(first, null);

  const second = applySdnFlowEditorSortNodeMessage(
    {
      targetType: "seq",
      seqKey: "payload.order",
      seqKeyType: "msg",
      order: "ascending",
      as_num: true,
    },
    {
      payload: { order: 5, name: "earlier" },
      parts: {
        id: "seq-1",
        index: 1,
        count: 2,
      },
    },
    { state },
  );

  assert.deepEqual(second.map((entry) => entry.payload.name), ["earlier", "later"]);
  assert.deepEqual(second.map((entry) => entry.parts.index), [0, 1]);
});

test("split node emits msg.parts metadata and preserves nested sequence context", () => {
  const outputs = applySdnFlowEditorSplitNodeMessage(
    {
      property: "payload",
      splt: "\\n",
      spltType: "str",
    },
    {
      _msgid: "msg-1",
      payload: "alpha\nbeta",
      parts: {
        id: "outer-seq",
        index: 4,
        count: 9,
      },
    },
  );

  assert.equal(outputs.length, 2);
  assert.equal(outputs[0]._msgid, undefined);
  assert.equal(outputs[0].payload, "alpha");
  assert.equal(outputs[1].payload, "beta");
  assert.equal(outputs[0].parts.id, outputs[1].parts.id);
  assert.equal(outputs[0].parts.index, 0);
  assert.equal(outputs[1].parts.index, 1);
  assert.equal(outputs[0].parts.count, 2);
  assert.deepEqual(outputs[0].parts.parts, {
    id: "outer-seq",
    index: 4,
    count: 9,
  });
});

test("join node auto mode reconstructs split string sequences and restores nested parts", () => {
  const state = {
    groups: new Map(),
  };

  const first = applySdnFlowEditorJoinNodeMessage(
    {
      mode: "auto",
    },
    {
      payload: "alpha",
      topic: "first",
      parts: {
        id: "group-1",
        index: 0,
        count: 2,
        type: "string",
        ch: "\n",
        parts: {
          id: "outer-seq",
          index: 3,
          count: 5,
        },
      },
    },
    { state },
  );

  assert.equal(first, null);

  const second = applySdnFlowEditorJoinNodeMessage(
    {
      mode: "auto",
    },
    {
      payload: "beta",
      topic: "second",
      parts: {
        id: "group-1",
        index: 1,
        count: 2,
        type: "string",
        ch: "\n",
        parts: {
          id: "outer-seq",
          index: 3,
          count: 5,
        },
      },
    },
    { state },
  );

  assert.deepEqual(second, {
    payload: "alpha\nbeta",
    topic: "second",
    parts: {
      id: "outer-seq",
      index: 3,
      count: 5,
    },
  });
});

test("join node custom mode groups keyed object payloads and flushes on timeout", () => {
  const state = {
    groups: new Map(),
  };
  const scheduled = [];
  const flushed = [];
  const clearCalls = [];

  const first = applySdnFlowEditorJoinNodeMessage(
    {
      mode: "custom",
      build: "object",
      key: "topic",
      property: "payload",
      count: "2",
    },
    {
      topic: "ada",
      payload: 3,
    },
    { state },
  );
  assert.equal(first, null);

  const second = applySdnFlowEditorJoinNodeMessage(
    {
      mode: "custom",
      build: "object",
      key: "topic",
      property: "payload",
      count: "2",
    },
    {
      topic: "grace",
      payload: 5,
    },
    { state },
  );
  assert.deepEqual(second, {
    topic: "grace",
    payload: {
      ada: 3,
      grace: 5,
    },
  });

  const timeoutResult = applySdnFlowEditorJoinNodeMessage(
    {
      mode: "custom",
      build: "string",
      property: "payload",
      joiner: "-",
      timeout: "0.01",
    },
    {
      payload: "linger",
    },
    {
      state,
      setTimer(callback, delay) {
        scheduled.push({ callback, delay });
        return callback;
      },
      clearTimer(handle) {
        clearCalls.push(handle);
      },
      onFlush(message) {
        flushed.push(message);
      },
    },
  );

  assert.equal(timeoutResult, null);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 10);
  scheduled[0].callback();
  assert.equal(clearCalls.length, 1);
  assert.deepEqual(flushed, [
    {
      payload: "linger",
    },
  ]);
});

test("batch node groups messages by count with overlap and preserves pending tail", () => {
  const state = {
    countQueue: [],
    intervalQueue: [],
    concatPending: new Map(),
    intervalHandle: null,
  };

  assert.equal(
    applySdnFlowEditorBatchNodeMessage(
      {
        mode: "count",
        count: "2",
        overlap: "1",
      },
      {
        _msgid: "msg-a",
        payload: "first",
      },
      { state },
    ),
    null,
  );

  const emitted = applySdnFlowEditorBatchNodeMessage(
    {
      mode: "count",
      count: "2",
      overlap: "1",
    },
    {
      _msgid: "msg-b",
      payload: "second",
    },
    { state },
  );

  assert.deepEqual(emitted.map((entry) => entry.payload), ["first", "second"]);
  assert.equal(state.countQueue.length, 1);
  assert.equal(state.countQueue[0].payload, "second");
});

test("batch node interval mode flushes queued messages on the configured timer", () => {
  const state = {
    countQueue: [],
    intervalQueue: [],
    concatPending: new Map(),
    intervalHandle: null,
  };
  const timers = [];
  const flushed = [];

  assert.equal(
    applySdnFlowEditorBatchNodeMessage(
      {
        mode: "interval",
        interval: "1",
      },
      {
        _msgid: "msg-1",
        payload: "alpha",
      },
      {
        state,
        setInterval(callback, delay) {
          timers.push({ callback, delay });
          return callback;
        },
        onFlush(messages) {
          flushed.push(messages);
        },
      },
    ),
    null,
  );

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1000);
  timers[0].callback();
  assert.deepEqual(flushed[0].map((entry) => entry.payload), ["alpha"]);
});

test("batch node concat mode waits for completed topics then emits one combined sequence", () => {
  const state = {
    countQueue: [],
    intervalQueue: [],
    concatPending: new Map(),
    intervalHandle: null,
  };

  const firstTopic = applySdnFlowEditorBatchNodeMessage(
    {
      mode: "concat",
      topics: [{ topic: "alpha" }, { topic: "beta" }],
    },
    {
      _msgid: "msg-alpha",
      topic: "alpha",
      payload: "A1",
      parts: {
        id: "seq-alpha",
        index: 0,
        count: 1,
      },
    },
    { state },
  );
  assert.equal(firstTopic, null);

  const secondTopic = applySdnFlowEditorBatchNodeMessage(
    {
      mode: "concat",
      topics: [{ topic: "alpha" }, { topic: "beta" }],
    },
    {
      _msgid: "msg-beta",
      topic: "beta",
      payload: "B1",
      parts: {
        id: "seq-beta",
        index: 0,
        count: 1,
      },
    },
    { state },
  );

  assert.deepEqual(secondTopic.map((entry) => entry.payload), ["A1", "B1"]);
  assert.deepEqual(secondTopic.map((entry) => entry.parts.index), [0, 1]);
});

test("yaml node parses string payloads into objects and stringifies objects back to yaml", () => {
  assert.deepEqual(
    applySdnFlowEditorYamlNodeMessage(
      {
        property: "payload",
      },
      {
        payload: "name: Ada\ncount: 3\n",
      },
    ),
    {
      payload: {
        name: "Ada",
        count: 3,
      },
    },
  );

  const stringified = applySdnFlowEditorYamlNodeMessage(
    {
      property: "payload",
    },
    {
      payload: {
        name: "Ada",
        count: 3,
      },
    },
  );

  assert.equal(stringified.payload, "name: Ada\ncount: 3\n");
});

test("xml node parses strings and builds xml from objects", async () => {
  const parsed = await applySdnFlowEditorXmlNodeMessage(
    {
      property: "payload",
      attr: "@",
      chr: "#",
    },
    {
      payload: "<root id=\"x\">value</root>",
    },
  );

  assert.deepEqual(parsed, {
    payload: {
      root: {
        "#": "value",
        "@": {
          id: "x",
        },
      },
    },
  });

  const built = await applySdnFlowEditorXmlNodeMessage(
    {
      property: "payload",
    },
    {
      payload: {
        root: {
          value: 42,
        },
      },
    },
  );

  assert.equal(
    built.payload,
    "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><root><value>42</value></root>",
  );
});

test("html node returns array output for single mode and split messages for multi mode", () => {
  const single = applySdnFlowEditorHtmlNodeMessage(
    {
      property: "payload",
      outproperty: "payload.items",
      tag: "li",
      ret: "text",
      as: "single",
    },
    {
      _msgid: "msg-1",
      payload: "<ul><li data-i=\"1\">Alpha</li><li data-i=\"2\">Beta</li></ul>",
    },
  );

  assert.deepEqual(single, {
    _msgid: "msg-1",
    payload: {
      items: ["Alpha", "Beta"],
    },
  });

  const multi = applySdnFlowEditorHtmlNodeMessage(
    {
      property: "payload",
      outproperty: "payload.attrs",
      tag: "li",
      ret: "attr",
      as: "multi",
    },
    {
      _msgid: "msg-1",
      payload: "<ul><li data-i=\"1\">Alpha</li><li data-i=\"2\">Beta</li></ul>",
    },
  );

  assert.deepEqual(multi, [
    {
      _msgid: "msg-1",
      payload: {
        attrs: {
          "data-i": "1",
        },
      },
      parts: {
        id: "msg-1",
        index: 0,
        count: 2,
        type: "string",
        ch: "",
      },
    },
    {
      _msgid: "msg-1",
      payload: {
        attrs: {
          "data-i": "2",
        },
      },
      parts: {
        id: "msg-1",
        index: 1,
        count: 2,
        type: "string",
        ch: "",
      },
    },
  ]);
});

test("csv node parses csv strings into row objects in array and message-per-row modes", () => {
  const arrayOutput = applySdnFlowEditorCsvNodeMessage(
    {
      spec: "rfc",
      sep: ",",
      hdrin: true,
      multi: "mult",
      skip: "0",
      strings: true,
    },
    {
      _msgid: "msg-1",
      payload: "name,count\r\nAda,3\r\nGrace,5\r\n",
    },
  );

  assert.deepEqual(arrayOutput, {
    _msgid: "msg-1",
    payload: [
      { name: "Ada", count: 3 },
      { name: "Grace", count: 5 },
    ],
    columns: "name,count",
  });

  const rowOutput = applySdnFlowEditorCsvNodeMessage(
    {
      spec: "rfc",
      sep: ",",
      hdrin: true,
      multi: "one",
      skip: "0",
      strings: true,
    },
    {
      _msgid: "msg-1",
      payload: "name,count\r\nAda,3\r\nGrace,5\r\n",
    },
  );

  assert.deepEqual(rowOutput, [
    {
      _msgid: "msg-1",
      payload: { name: "Ada", count: 3 },
      columns: "name,count",
      parts: {
        id: "msg-1",
        index: 0,
        count: 2,
      },
    },
    {
      _msgid: "msg-1",
      payload: { name: "Grace", count: 5 },
      columns: "name,count",
      parts: {
        id: "msg-1",
        index: 1,
        count: 2,
      },
    },
  ]);
});

test("csv node stringifies object rows and honors hdrout once plus reset", () => {
  const state = { hdrSent: false };

  const first = applySdnFlowEditorCsvNodeMessage(
    {
      spec: "rfc",
      sep: ",",
      hdrout: "once",
      ret: "\\n",
      temp: "name,count",
    },
    {
      payload: [
        { name: "Ada", count: 3 },
        { name: "Grace", count: 5 },
      ],
    },
    { state },
  );

  assert.equal(first.payload, "name,count\nAda,3\nGrace,5\n");
  assert.equal(first.columns, "name,count");
  assert.equal(state.hdrSent, true);

  const second = applySdnFlowEditorCsvNodeMessage(
    {
      spec: "rfc",
      sep: ",",
      hdrout: "once",
      ret: "\\n",
      temp: "name,count",
    },
    {
      payload: [{ name: "Linus", count: 8 }],
    },
    { state },
  );

  assert.equal(second.payload, "Linus,8\n");
  assert.equal(state.hdrSent, true);

  const reset = applySdnFlowEditorCsvNodeMessage(
    {
      spec: "rfc",
      sep: ",",
      hdrout: "once",
      ret: "\\n",
      temp: "name,count",
    },
    {
      reset: true,
      payload: [{ name: "Reset", count: 1 }],
    },
    { state },
  );

  assert.equal(reset.payload, "name,count\nReset,1\n");
  assert.equal(state.hdrSent, true);
});
