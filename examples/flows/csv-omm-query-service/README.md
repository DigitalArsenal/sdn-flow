# CSV OMM Query Service

This acceptance-scenario example models a deployable flow that:

1. polls CSV OMMs from CelesTrak on a timer
2. stores the resulting records in FlatSQL
3. accepts an authenticated HTTP query request
4. translates that request into a FlatSQL query
5. returns the matching rows as an HTTP response frame

The flow keeps query translation in a thin bridge plugin so the storage and
HTTP surfaces remain explicit in the graph instead of being hidden inside one
monolithic host adapter.

The runtime harness in `test/example-flow.test.js` exercises the checked-in
graph end-to-end with in-memory handlers.
