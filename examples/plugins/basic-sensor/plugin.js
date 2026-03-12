export const manifest = {
  pluginId: "com.digitalarsenal.examples.basic-sensor",
  name: "Basic Sensor",
  version: "0.1.0",
  pluginFamily: "sensor",
  methods: [
    {
      methodId: "detect",
      inputPorts: [
        {
          portId: "target",
        },
      ],
      outputPorts: [
        {
          portId: "detection",
        },
      ],
      maxBatch: 64,
      drainPolicy: "drain-until-yield",
    },
  ],
};

export const handlers = {
  detect({ inputs }) {
    return {
      outputs: inputs.map((frame) => ({
        ...frame,
        portId: "detection",
      })),
      backlogRemaining: 0,
      yielded: false,
    };
  },
};
