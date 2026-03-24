# Go SDN OMM Service

This is the daemon-style service example for a Go SDN node.

It uses:

- timer trigger
- outbound HTTP to CelesTrak
- outbound HTTP to a SeeSat-L source
- FlatSQL persistence
- inbound HTTPS download handling
- IPFS publish and pin
- SDS PNM notifications
- downstream observation association

This is the closest example to the intended deployment model for SDN updates
and local analytics delivered as compiled WASM flows.

The Go host plan models the IPFS surface as a local host service backed by the
official Kubo RPC client package `github.com/ipfs/kubo/client/rpc`, pointed at
`http://127.0.0.1:5001/api/v0`.
