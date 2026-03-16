# WasmEdge UDP Spooler

This demo is intentionally vendor-profile-specific.

It uses:

- network input for UDP packets
- filesystem output for spool files
- a `system-event` trigger that makes host packet injection explicit

This should not be described as generic-WASI portable. It is an explicit demo
for an extension-backed host profile.
