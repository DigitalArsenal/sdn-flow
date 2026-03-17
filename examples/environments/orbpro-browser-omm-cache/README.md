# OrbPro Browser OMM Cache

This demo shows the browser profile without pretending the browser can do raw
TCP, UDP, or unrestricted filesystem access.

It uses:

- timer trigger
- outbound HTTP to CelesTrak
- browser-managed cache storage
- same-app runtime inspection binding

The host profile is OrbPro browser with the `sdn-js` adapter family.
The intended browser-runtime binding path is
`startInstalledFlowBrowserFetchHost(...)` or a manual
`createInstalledFlowBrowserFetchEventListener(...)` registration in a worker
context.
