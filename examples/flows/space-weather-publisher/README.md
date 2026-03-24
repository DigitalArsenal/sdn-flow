# Space Weather Publisher

This acceptance-scenario example models a deployable flow that:

1. polls NOAA SWPC planetary K-index data on a timer
2. stores the resulting records in FlatSQL
3. writes the same aligned-binary records to a shared archive directory
4. emits an SDS PNM after each synchronized update
5. serves both archive downloads and REST queries over the stored data

The checked-in graph keeps the archive, notification, and query surfaces
explicit instead of hiding them inside one host wrapper. The runtime harness in
`test/example-flow.test.js` exercises the full flow end-to-end with in-memory
handlers.
