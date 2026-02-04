# MPT To-Do List

## Direct Peer-to-Peer Token Delivery

The current prototype broadcasts transfer TXs via WoC and the recipient discovers them by scanning address history. A direct browser-to-browser delivery model would be more aligned with the SPV design.

### Options for browser-to-browser delivery

**WebRTC** -- peer-to-peer data channels between browsers. No server needed for the data transfer itself (though a small signaling server is needed for the initial handshake). Both wallets exchange a short connection code, then the raw TX hex flows directly between them.

**WebSocket relay** -- a lightweight relay server that both browsers connect to. Wallet 1 posts the TX to a "room" (keyed by recipient address or a shared code), Wallet 2 picks it up. The relay never needs to understand the TX -- it's just passing bytes.

**QR code / copy-paste** -- simplest approach. Wallet 1 displays the raw TX hex (or a compressed version) as a QR code or copyable text. Wallet 2 scans/pastes it. Works offline on the sender's side.

**BIP270-style payment protocol** -- Wallet 2 hosts a simple endpoint (could be a service worker) that accepts incoming TX submissions. Wallet 1 POSTs the TX directly to that endpoint.

### Simplest implementation for the prototype

Add an "Export TX" button that copies the raw TX hex to clipboard, and an "Import TX" field on the receiving wallet. No server needed, works across any communication channel. The recipient can then broadcast it themselves.

The architecture already supports this -- `createTransfer()` produces a `rawHex` before broadcasting. The change is to separate "build TX" from "broadcast TX" and let the user choose which path.

### Full direct delivery flow

1. **Wallet 1** builds the transfer TX (with OP_RETURN containing proof chain) and sends the raw TX hex directly to **Wallet 2** -- via any channel (QR code, messaging, Bluetooth, NFC, etc.)

2. **Wallet 2** validates the TX locally:
   - Parses the OP_RETURN, extracts token metadata and proof chain
   - Verifies the Token ID matches the genesis
   - Verifies the Merkle proofs against block headers it already has (or fetches)

3. **Wallet 2** submits the TX to one or more Transaction Processors (miners/nodes) for inclusion in a block

4. Once mined, Wallet 2 fetches the Merkle proof for the new TX and extends the proof chain -- this is the final "settled" confirmation
