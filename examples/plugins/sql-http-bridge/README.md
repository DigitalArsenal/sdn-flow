# SQL HTTP Bridge

This example plugin manifest models the thin flow-level adapter between an
HTTP query surface and a FlatSQL query method.

The bridge keeps the flow graph explicit:

1. convert an authenticated HTTP request into a `SqlQueryRequest`
2. feed the request into the FlatSQL store
3. convert the `SqlQueryResult` rows back into an HTTP response frame

The runtime harness in `test/example-flow.test.js` provides the example
handlers used to exercise the flow end-to-end.
