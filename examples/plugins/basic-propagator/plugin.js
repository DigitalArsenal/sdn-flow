export const manifest = {
  pluginId: "com.digitalarsenal.examples.basic-propagator",
  name: "Basic Propagator",
  version: "0.1.0",
  pluginFamily: "propagator",
  methods: [
    {
      methodId: "propagate",
      inputPorts: [
        {
          portId: "request",
        },
      ],
      outputPorts: [
        {
          portId: "state",
        },
      ],
      maxBatch: 32,
      drainPolicy: "drain-to-empty",
    },
  ],
};

export const handlers = {
  propagate({ inputs }) {
    return {
      outputs: inputs.map((frame) => ({
        ...frame,
        portId: "state",
      })),
      backlogRemaining: 0,
      yielded: false,
    };
  },
};
