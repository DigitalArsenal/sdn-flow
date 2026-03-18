1. Install `flatsql@0.4.0` into the repo test surface. (done)

2. Add a local `flatsql-store` plugin implementation under `examples/plugins/flatsql-store/plugin.js` backed by the installed package. (done)

3. Exercise the canonical FlatSQL store methods through that local plugin:
   - `upsert_records`
   - `query_sql`
   - `query_objects_within_radius`
   (done)

4. Add a focused test that loads the local plugin package and verifies all canonical methods execute successfully. (done)

5. Keep the example/plugin contract aligned with the existing `flatsql-store` manifest instead of creating a second SQLite API surface. (done)
