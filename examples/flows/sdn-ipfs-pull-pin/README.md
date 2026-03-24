# SDN IPFS Pull And Pin

This acceptance-scenario example models a deployable flow that:

1. receives an entity profile message from the SDN fabric
2. extracts the offered SDS messages that should be watched
3. reacts to SDS publish notifications for those watched messages
4. pulls the aligned records from IPFS
5. applies a user retention policy before archiving the retained records

The checked-in graph keeps profile import, offer discovery, PNM watch, IPFS
pull, and retention policy application as separate nodes. The runtime harness in
`test/example-flow.test.js` exercises the full workflow end-to-end with in-memory
handlers and an explicit one-item pin retention policy.
