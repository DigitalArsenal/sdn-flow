# sdn-js Catalog Gateway

This demo is the shared JS-host profile example for Node, Deno, and Bun.

It uses:

- timer trigger
- outbound HTTP fetch
- filesystem output
- pipe logging
- inbound HTTP request handling

If one JS runtime cannot satisfy one of those capabilities, that gap should be
documented as unsupported for the host profile rather than solved by a new
plugin ABI.
