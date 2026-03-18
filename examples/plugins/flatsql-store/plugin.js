import { DirectAccessor, FlatSQLDatabase } from "flatsql";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ORBITAL_RECORD_SCHEMA = `
table OrbitalRecord {
  norad: int (id);
  name: string;
  distanceKm: float;
  source: string;
  category: string;
}
`;

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRecord(payload = {}) {
  const norad = normalizeNumber(
    payload.norad ?? payload.objectNorad ?? payload.anchorNorad,
    0,
  );
  return {
    norad,
    name: normalizeString(payload.name, null) ?? `OBJECT-${norad || "unknown"}`,
    distanceKm: normalizeNumber(payload.distanceKm, 0),
    source: normalizeString(payload.source, null) ?? "local",
    category:
      normalizeString(payload.category, null) ?? "space-object",
  };
}

function encodeRecord(record) {
  return encoder.encode(JSON.stringify(record));
}

function decodeRecord(bytes) {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
}

function createAccessor() {
  const accessor = new DirectAccessor();
  accessor.registerAccessor("OrbitalRecord", (data, path) => {
    let current = decodeRecord(data);
    for (const segment of Array.isArray(path) ? path : []) {
      if (current === null || current === undefined) {
        return null;
      }
      current = current[segment];
    }
    return current ?? null;
  });
  accessor.registerBuilder("OrbitalRecord", (fields) =>
    encodeRecord(normalizeRecord(fields)),
  );
  return accessor;
}

function createDatabase(accessor) {
  return FlatSQLDatabase.fromSchema(
    ORBITAL_RECORD_SCHEMA,
    accessor,
    "flatsql-local",
  );
}

function createOutputFrame(
  portId,
  schemaName,
  fileIdentifier,
  payload,
  inputFrame = null,
) {
  return {
    portId,
    typeRef: {
      schemaName,
      fileIdentifier,
    },
    alignment: inputFrame?.alignment ?? 8,
    offset: inputFrame?.offset ?? 0,
    size: inputFrame?.size ?? 0,
    ownership: inputFrame?.ownership ?? "shared",
    generation: inputFrame?.generation ?? 0,
    mutability: inputFrame?.mutability ?? "immutable",
    traceId: inputFrame?.traceId ?? `${fileIdentifier}:${Date.now().toString(36)}`,
    streamId: inputFrame?.streamId ?? 1,
    sequence: inputFrame?.sequence ?? 1,
    payload,
  };
}

export function createHandlers() {
  const accessor = createAccessor();
  const recordsByNorad = new Map();
  let database = createDatabase(accessor);

  function rebuildDatabase() {
    database = createDatabase(accessor);
    for (const record of recordsByNorad.values()) {
      database.insert("OrbitalRecord", record);
    }
  }

  return {
    upsert_records({ inputs = [] }) {
      const outputs = [];
      for (const input of inputs) {
        const record = normalizeRecord(input.payload ?? {});
        if (!record.norad) {
          continue;
        }
        recordsByNorad.set(record.norad, record);
        outputs.push(
          createOutputFrame(
            "stored",
            "StoredRecordRef.fbs",
            "STRF",
            {
              norad: record.norad,
              table: "OrbitalRecord",
            },
            input,
          ),
        );
      }
      rebuildDatabase();
      return {
        outputs,
        backlogRemaining: 0,
        yielded: false,
      };
    },

    query_sql({ inputs = [] }) {
      const inputFrame = inputs.at(-1) ?? null;
      const sql =
        normalizeString(inputFrame?.payload?.sql, null) ??
        "SELECT * FROM OrbitalRecord";
      const result = database.query(sql);
      return {
        outputs: [
          createOutputFrame(
            "rows",
            "SqlQueryResult.fbs",
            "SQLR",
            {
              sql,
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rowCount,
            },
            inputFrame,
          ),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    },

    query_objects_within_radius({ inputs = [] }) {
      const inputFrame = inputs.at(-1) ?? null;
      const query = inputFrame?.payload ?? {};
      const radiusKm = normalizeNumber(query.radiusKm, 0);
      const result = database.query(
        `SELECT norad FROM OrbitalRecord WHERE distanceKm BETWEEN 0 AND ${radiusKm}`,
      );
      const matches = result.rows
        .map((row) => normalizeNumber(row[0], 0))
        .filter((norad) => norad > 0);
      return {
        outputs: [
          createOutputFrame(
            "matches",
            "ProximitySelection.fbs",
            "PRXY",
            {
              anchorNorad: normalizeNumber(query.anchorNorad, 0),
              radiusKm,
              sampleCount: normalizeNumber(query.samplesPerOrbit, 0),
              orbitCount: normalizeNumber(query.orbitCount, 0),
              matches,
            },
            inputFrame,
          ),
        ],
        backlogRemaining: 0,
        yielded: false,
      };
    },
  };
}

export default {
  createHandlers,
};
