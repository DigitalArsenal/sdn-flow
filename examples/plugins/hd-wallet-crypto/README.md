# HD Wallet Crypto

This example treats `hd-wallet-wasm` as an infrastructure plugin, not as a
special-case host helper.

It exposes manifest-defined methods for:

- per-field encryption
- detached signatures

The plugin still follows the same contract as every other flow dependency:

- embedded manifest
- typed ports
- explicit capability requirements
- compiled-flow use through the same one-artifact deployment model
