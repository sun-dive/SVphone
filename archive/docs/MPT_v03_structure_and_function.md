# MPT Prototype v03 -- Structure and Function

## Overview

The Merkle Proof Token (MPT) is a token protocol on BSV mainnet that uses P2PKH outputs for ownership and OP_RETURN outputs for metadata. Token validity is proven exclusively through Merkle proofs and block headers (SPV), with no dependency on UTXO lookups, indexers, or trusted third parties for verification.

Prototype v03 enforces a clean architectural separation between the pure SPV token protocol and the wallet layer that interacts with the blockchain.

**Network:** BSV Mainnet (real BSV)

---

## Token Design

An MPT token is a BSV transaction with a specific output structure. There is no custom locking script -- ownership uses standard P2PKH, and all token metadata lives in a separate OP_RETURN output.

### Transaction Structure

**Genesis TX (mint):**

```
Input 0:   Funding UTXO (signed by minter)
Output 0:  P2PKH to minter's address (1 sat) -- the token UTXO
Output 1:  OP_RETURN with token metadata (0 sat) -- the token data
Output 2:  Change back to minter (if needed)
```

**Transfer TX:**

```
Input 0:   Token UTXO from previous owner (signed by owner)
Input 1+:  Funding UTXOs for fees (signed by sender)
Output 0:  P2PKH to recipient's address (1 sat) -- new token UTXO
Output 1:  OP_RETURN with token metadata + proof chain (0 sat) -- updated token data
Output 2:  Change back to sender (if needed)
```

The 1-sat P2PKH output carries ownership. Whoever can spend it controls the token. The OP_RETURN output carries all metadata, rules, and (on transfers) the proof chain. These two outputs always appear as Output 0 and Output 1 respectively.

### On-Chain Fields

The OP_RETURN contains these fields as separate pushdata chunks:

| Chunk | Field | Size | Description |
|-------|-------|------|-------------|
| 0 | `OP_0` | 1B | Standard OP_RETURN prefix |
| 1 | `OP_RETURN` | 1B | Marks output as unspendable |
| 2 | `"MPT"` | 3B | Protocol identifier |
| 3 | version | 1B | Protocol version (currently `0x01`) |
| 4 | tokenName | variable | UTF-8 human-readable name |
| 5 | tokenRules | 8B | Packed rules: supply, divisibility, restrictions bitfield, version |
| 6 | tokenAttributes | variable | Application-specific attributes (hex) |
| 7 | ownerPubKey | 33B | Compressed public key of current owner |
| 8 | stateData | variable | Mutable application state (min 1 byte) |
| 9 | genesisTxId | 32B | *Transfer only:* raw genesis TX hash |
| 10 | proofChainBinary | variable | *Transfer only:* compact binary proof chain |

Chunks 0-8 are present on every TX (genesis and transfer). Chunks 9-10 are only present on transfer TXs, carrying the proof chain so the recipient can verify the token's full history.

### What Changes Between Transfers

| Field | Mutable? | Notes |
|-------|----------|-------|
| tokenName | Copied unchanged | Set at genesis |
| tokenRules | Copied unchanged | Set at genesis, defines restrictions |
| tokenAttributes | Currently copied | Could be mutable if rules allow |
| ownerPubKey | **Changes** | Updated to recipient's pubkey on each transfer |
| stateData | Currently copied | Could be mutable if rules allow |
| genesisTxId | Fixed | Always references the original mint TX |
| proofChainBinary | **Grows** | New Merkle proof entry prepended on each transfer |

### Encoding Format

MPT uses **raw pushdata chunks** in the OP_RETURN output. Each field is a separate pushdata element in the script, identified by position. This requires no external libraries, schemas, or deserializers -- any Bitcoin library that can parse standard scripts can decode MPT metadata.

Compared to other BSV token encodings:

| | MPT (Raw Pushdata) | 1Sat Ordinals (Content Blob) | RUN (CBOR) | STAS (Script Opcodes) | Tokenized (Protobuf) |
|---|---|---|---|---|---|
| Parse complexity | Trivial | Varies | Library needed | Script interpreter | Library + schema |
| External dependencies | None | Content decoders | CBOR library | Script engine | Protobuf runtime |
| Indexer required | **No** | Yes | Yes | Partial | Yes |
| Self-contained TX | **Yes** | Partial | No | No | No |

The zero-dependency parsing aligns with MPT's SPV-only philosophy. The protocol is simple enough that positional encoding isn't a burden.

### Token ID

```
Token ID = SHA-256(genesisTxId bytes || outputIndex as 4-byte LE)
```

The Token ID is a deterministic, purely local computation. It binds the token's identity to its genesis transaction. No network access is required to compute or verify it.

**Future consideration:** Including `tokenRules` in the Token ID hash (`SHA-256(genesisTxId || outputIndex LE || tokenRules)`) would cryptographically bind the rules to the token's identity. If someone tampered with `tokenRules` in a transfer TX, the Token ID would no longer match and verification would fail immediately. This is a zero-cost hardening that doesn't affect SPV verification.

### Verification Model

Token validity is proven exclusively through Merkle proofs and block headers:

1. Token ID matches `SHA-256(genesisTxId || outputIndex LE)`
2. Every entry in the proof chain has a valid Merkle proof (double SHA-256)
3. Every Merkle root matches its block header at that height
4. The oldest entry's txId matches the genesis txId

The proof chain travels with the token. Any node with block headers can verify it without replaying history or querying an indexer.

### tokenRules Enforcement

`tokenRules` is an 8-byte packed field (4 x uint16 LE): supply, divisibility, restrictions (bitfield), and version. It is set at genesis and copied unchanged on every transfer.

**Application-level, not consensus-level:** MPT's OP_RETURN is unspendable -- miners don't execute logic on it. Rules cannot be enforced at the consensus layer. Instead, MPT **detects** rule violations during verification rather than **preventing** them.

**Enforcement as recipient validation:** When a recipient wallet receives a transfer, it walks the proof chain comparing each consecutive pair of OP_RETURN states. If a transfer violates a rule (e.g. changed `stateData` when rules say immutable), the recipient rejects that **transaction** -- not the token. The sender still holds the token and can try again with a rule-compliant transfer.

**Potential rule types** (restrictions bitfield):
- `stateData` immutable after genesis
- `tokenAttributes` immutable after genesis
- Transfers restricted to specific conditions

Each entry only needs to be compared against its immediate predecessor. The linear chain walk naturally handles this.

### Large Data Considerations

BSV has no OP_RETURN size limit (removed in the Genesis upgrade, February 2020). The practical limit is the max transaction size (up to 4GB at the consensus level).

The current design rewrites the full OP_RETURN on every transfer, including `stateData`. The proof chain does **not** contain `stateData` -- it only stores txId, blockHeight, merkleRoot, and Merkle path nodes. So large stateData does not bloat the proof chain, but it does increase the cost of every transfer TX.

For large stateData, the cleanest mitigation is **hash-only on-chain**: store `SHA-256(stateData)` in the OP_RETURN (32 bytes regardless of data size), and pass the actual data in the bundle or fetch it from the genesis TX.

---

## Architecture

```
+------------------------------------------------------+
|                    Browser UI (app.ts)                |
+------------------------------------------------------+
         |                    |                |
         v                    v                v
+----------------+  +------------------+  +-----------+
| Token Builder  |  |  Token Store     |  |  Wallet   |
| (tokenBuilder) |  |  (tokenStore)    |  |  Provider |
|                |->|  localStorage    |  | (WoC API) |
+----------------+  +------------------+  +-----------+
         |                                     |
         v                                     |
+------------------------------------------------------+
|              Token Protocol (tokenProtocol.ts)        |
|         Pure SPV: Merkle proofs + block headers       |
|              ZERO network dependencies                |
+------------------------------------------------------+
         |
         v
+------------------------------------------------------+
|              OP_RETURN Codec (opReturnCodec.ts)       |
|         Encode/decode token metadata in script        |
+------------------------------------------------------+
```

**Key rule:** The token protocol layer never imports from the wallet layer. Verification can run offline with pre-fetched block headers.

---

## Module Inventory

| File | Layer | Purpose |
|------|-------|---------|
| `tokenProtocol.ts` | Protocol | Token ID, Merkle proof verification, proof chain validation. Only import: `@bsv/sdk` (Hash). |
| `opReturnCodec.ts` | Protocol | OP_RETURN script encoding/decoding. Binary proof chain codec. |
| `walletProvider.ts` | Wallet | WhatsOnChain API client. UTXOs, broadcast, raw TX, block headers, Merkle proofs, address history. |
| `tokenStore.ts` | Wallet | localStorage persistence for tokens and proof chains. |
| `tokenBuilder.ts` | Wallet | Token lifecycle: mint, transfer, verify, detect incoming. UTXO quarantine. |
| `app.ts` | UI | Browser entry point. DOM manipulation, event handlers, rendering. |
| `index.html` | UI | Single-page wallet interface. |
| `build.mjs` | Tooling | esbuild bundler: `src/app.ts` -> `bundle.js` (IIFE, browser). |
| `serve.mjs` | Tooling | Dev server with WoC reverse proxy to bypass CORS. |

---

## Dependency Graph

```
tokenProtocol.ts  -->  @bsv/sdk (Hash only)

opReturnCodec.ts  -->  @bsv/sdk (LockingScript, OP)
                  -->  tokenProtocol.ts (types: MerkleProofEntry, MerklePathNode)

walletProvider.ts -->  @bsv/sdk (PrivateKey, Transaction)
                  -->  tokenProtocol.ts (types: MerkleProofEntry, MerklePathNode, BlockHeader)

tokenStore.ts     -->  tokenProtocol.ts (types: ProofChain)

tokenBuilder.ts   -->  @bsv/sdk (Transaction, P2PKH, PublicKey, LockingScript)
                  -->  walletProvider.ts (WalletProvider, Utxo)
                  -->  tokenStore.ts (TokenStore, OwnedToken)
                  -->  tokenProtocol.ts (computeTokenId, createProofChain, extendProofChain,
                                         verifyProofChainAsync, ProofChain, BlockHeader,
                                         VerificationResult)
                  -->  opReturnCodec.ts (encodeOpReturn, decodeOpReturn, encodeTokenRules)

app.ts            -->  @bsv/sdk (PrivateKey)
                  -->  walletProvider.ts (WalletProvider)
                  -->  tokenBuilder.ts (TokenBuilder)
                  -->  tokenStore.ts (TokenStore, LocalStorageBackend, OwnedToken)
```

---

## Token Protocol (tokenProtocol.ts)

This is the core of the MPT system. It runs in any environment with zero network access.

### Token ID

```
Token ID = SHA-256( genesisTxId bytes || outputIndex as 4-byte little-endian )
```

The token ID is deterministic and immutable. It is derived from the genesis transaction hash and the output index (always 0 in current implementation). It never changes across transfers.

### Proof Chain

A proof chain is an ordered list of Merkle proof entries, newest first:

```
ProofChain {
  genesisTxId: string          // the origin TX hash
  entries: MerkleProofEntry[]  // [newest transfer, ..., genesis]
}
```

Each entry contains:
- `txId` -- the transaction hash
- `blockHeight` -- the block it was mined in
- `merkleRoot` -- the claimed Merkle root of that block
- `path` -- array of `{ hash, position: 'L' | 'R' }` nodes from leaf to root

### Verification Algorithm

A token is valid if and only if all four conditions hold:

1. **Token ID matches genesis:** `SHA-256(genesisTxId || outputIndex) == tokenId`
2. **Every Merkle proof is valid:** For each entry, hash the txId through the path using Bitcoin's double SHA-256 and confirm the computed root matches the claimed `merkleRoot`.
3. **Every Merkle root matches its block header:** The `merkleRoot` in each entry must match the `merkleRoot` field of the block header at that `blockHeight`.
4. **The oldest entry is the genesis TX:** `entries[last].txId == genesisTxId`

The protocol provides two verification functions:
- `verifyProofChain(chain, headers)` -- synchronous, takes a pre-populated `Map<height, BlockHeader>`
- `verifyProofChainAsync(chain, getBlockHeader)` -- fetches headers on demand via callback

The block header source is pluggable. It can be a local cache, a peer-to-peer connection, or an API. The verification logic itself never makes network calls.

### Merkle Proof Mechanics

Bitcoin Merkle trees use double SHA-256. At each level:
- If the sibling is on the **right** (`R`): `hash = dSHA256(current || sibling)`
- If the sibling is on the **left** (`L`): `hash = dSHA256(sibling || current)`

The final computed hash must equal the block's Merkle root.

---

## OP_RETURN Format (opReturnCodec.ts)

### Script Structure

Each field is a separate pushdata chunk:

```
Chunk 0:  OP_0
Chunk 1:  OP_RETURN
Chunk 2:  "MPT"           (3 bytes, protocol prefix)
Chunk 3:  0x01             (1 byte, version)
Chunk 4:  tokenName        (UTF-8, variable length)
Chunk 5:  tokenRules       (8 bytes, 4x uint16 LE)
Chunk 6:  tokenAttributes  (variable hex)
Chunk 7:  ownerPubKey      (33 bytes, compressed public key)
Chunk 8:  stateData        (variable hex, minimum 1 byte)
```

Transfer TXs append two additional chunks:

```
Chunk 9:  genesisTxId      (32 bytes, raw hash)
Chunk 10: proofChainBinary (compact binary encoding)
```

### Token Rules (8 bytes)

```
Bytes 0-1: supply        (uint16 LE, 0 = unlimited)
Bytes 2-3: divisibility  (uint16 LE, 0 = NFT)
Bytes 4-5: restrictions  (uint16 LE bitfield, 0 = none)
Bytes 6-7: version       (uint16 LE)
```

### Proof Chain Binary Encoding

```
[1 byte]  entry count
Per entry:
  [32 bytes] txId
  [4 bytes]  blockHeight (uint32 LE)
  [32 bytes] merkleRoot
  [1 byte]   path node count
  Per node:
    [32 bytes] hash
    [1 byte]   position (0 = L, 1 = R)
```

### Pushdata Encoding

Data length determines the opcode:
- 1-75 bytes: opcode = length (direct push)
- 76-255 bytes: OP_PUSHDATA1 (0x4c), 1-byte length
- 256-65535 bytes: OP_PUSHDATA2 (0x4d), 2-byte length LE
- Larger: OP_PUSHDATA4 (0x4e), 4-byte length LE

---

## Transaction Structures

### Genesis TX (Mint)

```
Input 0:   P2PKH(owner)  -- funding UTXO
Output 0:  P2PKH(owner)  -- 1 sat, the token UTXO
Output 1:  OP_RETURN      -- 0 sat, token metadata (no proof chain yet)
Output 2:  P2PKH(owner)  -- change
```

The genesis TX creates a new token. Token ID is derived from this TX's hash. The OP_RETURN does not include genesisTxId or proof chain fields (chunks 9-10 are absent).

### Transfer TX

```
Input 0:   P2PKH(sender)  -- the token UTXO (1 sat)
Input 1+:  P2PKH(sender)  -- funding UTXO(s)
Output 0:  P2PKH(recipient) -- 1 sat, new token UTXO
Output 1:  OP_RETURN        -- 0 sat, updated metadata + proof chain
Output 2:  P2PKH(sender)    -- change
```

The transfer TX spends the token UTXO as Input 0 and creates a new token UTXO for the recipient. The OP_RETURN includes the genesisTxId and the full proof chain in binary, so the recipient can verify the token's history from on-chain data alone.

### Send BSV TX (Plain Transfer)

```
Input(s):  P2PKH(sender)    -- funding UTXO(s)
Output 0:  P2PKH(recipient) -- amount in sats
Output 1:  P2PKH(sender)    -- change
```

Standard BSV payment. Token UTXOs are excluded from input selection.

---

## UTXO Quarantine System

All UTXOs with value <= 1 sat are permanently quarantined and never used as funding inputs. This protects:

- **MPT tokens** (1-sat P2PKH outputs with OP_RETURN metadata)
- **Ordinals** (1-sat inscription outputs)
- **1Sat Ordinals** and other token protocols that use 1-sat UTXOs
- **Any unknown token type** that may arrive at the wallet address

The quarantine is unconditional. There is no "cleared" list or override mechanism.

### The Only Exception

`createTransfer()` is the sole code path that spends a 1-sat UTXO. It does so as Input 0, spending a specific token that the user explicitly selected for transfer. This is an intentional, user-initiated action on a known token.

### Auto-Import on Quarantine

When `getSafeUtxos()` encounters a quarantined 1-sat UTXO, it fires off `tryAutoImport()` in the background. This fetches the source TX, checks for MPT OP_RETURN data addressed to this wallet, and imports the token into the local store if found. The UTXO remains quarantined regardless of the auto-import result.

### Funding UTXO Selection

All three spending operations use `getSafeUtxos()`:
- `createGenesis()` -- mint a new token
- `createTransfer()` -- fund the transfer TX (separate from the token UTXO)
- `sendSats()` -- plain BSV payment

UTXO combinations are tried in order: singles (sorted by value ascending), then pairs, then triples. The cheapest combination that covers the outputs plus fee is selected.

---

## Wallet Provider (walletProvider.ts)

All network operations are isolated in the WalletProvider class. It communicates with the WhatsOnChain API.

### API Endpoints Used

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/address/{addr}/unspent` | GET | Fetch UTXOs for the wallet |
| `/address/{addr}/history` | GET | Fetch TX history for incoming detection |
| `/tx/{txId}/hex` | GET | Fetch raw transaction hex |
| `/tx/{txId}/proof/tsc` | GET | Fetch Merkle proof (TSC format) |
| `/block/height/{height}` | GET | Get block hash from height |
| `/block/{hash}/header` | GET | Get block header (merkleRoot, time, etc.) |
| `/tx/raw` | POST | Broadcast signed transaction |

### Rate Limiting

A 200ms minimum delay between API requests prevents HTTP 429 errors. Implemented via `throttledFetch()`.

### TX Cache

Raw transaction hex is cached in-memory (`Map<txId, hex>`) to avoid re-fetching the same TX.

### CORS Proxy

When running on `localhost`, requests are routed through `/woc/v1/bsv/main` which the dev server (`serve.mjs`) proxies to `api.whatsonchain.com`. This avoids CORS errors that occur when the browser fetches from a different origin.

### TSC Merkle Proof Parsing

WhatsOnChain returns proofs in TSC format:
```json
[{ "index": N, "txOrId": "...", "target": "blockhash", "nodes": ["hash", "*", ...] }]
```

The response is an array (the first element is used). The `index` determines left/right positioning at each tree level:
- Even index: sibling is on the right
- Odd index: sibling is on the left
- `"*"` entries (duplicate pairs) are skipped

The block header is fetched separately using the `target` (block hash) to obtain the Merkle root.

---

## Token Store (tokenStore.ts)

Persists tokens and proof chains in localStorage via a pluggable `StorageBackend` interface.

### Storage Keys

All keys are prefixed with `mpt:data:` (configured at initialization):

| Key Pattern | Value |
|-------------|-------|
| `mpt:data:token:{tokenId}` | OwnedToken JSON |
| `mpt:data:proof:{tokenId}` | ProofChain JSON |

### OwnedToken Fields

| Field | Type | Description |
|-------|------|-------------|
| `tokenId` | string | SHA-256 hash, permanent identifier |
| `genesisTxId` | string | Hash of the genesis transaction |
| `genesisOutputIndex` | number | Output index in genesis TX (always 0) |
| `currentTxId` | string | Hash of the TX holding the current token UTXO |
| `currentOutputIndex` | number | Output index of the current token UTXO |
| `tokenName` | string | Human-readable name |
| `tokenRules` | string | 8-byte hex (supply, divisibility, restrictions, version) |
| `tokenAttributes` | string | Variable hex (e.g. serial number) |
| `ownerPubKey` | string | 33-byte compressed public key hex |
| `stateData` | string | Variable hex, application-specific |
| `satoshis` | number | Always 1 (TOKEN_SATS) |
| `status` | TokenStatus | `'active'`, `'pending_transfer'`, or `'transferred'` |
| `createdAt` | string? | ISO timestamp |
| `feePaid` | number? | Fee in satoshis for the creating TX |
| `transferTxId` | string? | Set when status is `pending_transfer` |

### Token Status Lifecycle

```
Minted (createGenesis)
    |
    v
  active -----> pending_transfer -----> transferred
           createTransfer()        confirmTransfer()
```

The recipient receives the token as `active` via auto-import or manual "Check Incoming".

---

## Token Builder (tokenBuilder.ts)

Orchestrates all token operations. Coordinates between the wallet provider, token store, and token protocol.

### Operations

#### createGenesis(params)

1. Fetch safe UTXOs (quarantine applied)
2. Build OP_RETURN with token metadata
3. Construct TX: funding input -> token output (1 sat) + OP_RETURN + change
4. Sign and broadcast
5. Compute token ID from TX hash
6. Store token with empty proof chain
7. Return `{ txId, tokenId }`

#### createTransfer(tokenId, recipientPubKeyHex)

1. Load token from store, verify status is `active`
2. Load proof chain for the token
3. Fetch the source TX of the current token UTXO
4. Fetch safe UTXOs for funding (quarantine applied)
5. Construct TX: token UTXO as Input 0 + funding inputs -> recipient P2PKH (1 sat) + OP_RETURN (with genesisTxId + proof chain binary) + change
6. Sign and broadcast
7. Mark token as `pending_transfer` with `transferTxId`
8. Return `{ txId, tokenId }`

#### confirmTransfer(tokenId)

Marks a `pending_transfer` token as `transferred`.

#### sendSats(recipientAddress, amount)

Standard BSV payment using safe UTXOs only.

#### verifyToken(tokenId)

1. Load token and proof chain from store
2. If no proof chain, attempt to fetch Merkle proof from WoC on demand
3. Verify token ID matches genesis (pure computation)
4. Fetch block headers for each proof chain entry height
5. Delegate to `tokenProtocol.verifyProofChainAsync()` for cryptographic verification
6. Return `{ valid, reason }`

#### pollForProof(tokenId, txId)

Polls WoC for a Merkle proof every 15 seconds, up to 60 attempts. Once found, stores the proof chain. Used after minting to wait for block confirmation.

#### fetchMissingProofs()

Scans all stored tokens for missing proof chains and attempts to fetch them. Handles tokens that were minted or received but the page was closed before confirmation.

#### checkIncomingTokens()

1. Fetch address history + UTXOs (merged, deduplicated)
2. For each unknown TX, fetch raw hex and parse outputs
3. Look for OP_RETURN with MPT prefix where `ownerPubKey` matches this wallet
4. Extract genesisTxId and proof chain from on-chain binary data
5. Import new tokens into the store

### Fee Estimation

```
size = TX_OVERHEAD (10) + numInputs * BYTES_PER_INPUT (148)
     + sum(actual output script lengths + 9 bytes each)
     + BYTES_PER_P2PKH_OUTPUT (34) for the change output

fee = ceil(size * feePerKb / 1000)
```

Default fee rate: 150 sats/KB.

---

## Browser UI (app.ts + index.html)

### Initialization

1. Load or generate a private key (stored as WIF in `mpt:wallet:wif`)
2. Create WalletProvider, TokenStore, TokenBuilder
3. Display address, public key, WIF
4. Bind button handlers
5. Refresh balance, token list
6. Run `silentCheckIncoming()` and `fetchMissingProofs()` in background

### UI Sections

| Section | Purpose |
|---------|---------|
| Wallet | Address, public key, WIF, balance. Refresh, new wallet, restore from WIF. |
| Send BSV | Plain satoshi transfer to an address. |
| Mint Token | Create a new NFT with a name and optional attributes. |
| My Tokens | List of all tokens with status badges. Check Incoming button. |
| Transfer Token | Send a token to a recipient public key. |
| Verify Token | SPV verification of a token's proof chain against block headers. |

### Token Card Display

Each token card shows:
- Name with status badge (Active / Pending Transfer / Transferred)
- Token ID, Current TXID, Output index
- Owner public key (truncated), satoshis, creation date, fee paid
- Transfer TXID (if pending)
- Action buttons: Select for Transfer, Verify, Confirm Sent, View TX links

### Background Operations (Page Load)

- `refreshBalance()` -- fetch balance from WoC
- `silentCheckIncoming()` -- scan for incoming tokens (no error display)
- `fetchMissingProofs()` -- fetch proofs for unconfirmed tokens

---

## Dev Server (serve.mjs)

1. Runs esbuild to compile `src/app.ts` -> `bundle.js`
2. Starts HTTP server on port 3000
3. Routes `/woc/*` requests to `api.whatsonchain.com` (HTTPS proxy with `Access-Control-Allow-Origin: *`)
4. Serves static files (index.html, bundle.js, source maps)

Usage: `node serve.mjs` then open `http://localhost:3000`

---

## Constants

| Constant | Value | Used In |
|----------|-------|---------|
| `TOKEN_SATS` | 1 | Token UTXO value, quarantine threshold |
| `DEFAULT_FEE_PER_KB` | 150 | Fee estimation |
| `BYTES_PER_INPUT` | 148 | P2PKH input with signature |
| `BYTES_PER_P2PKH_OUTPUT` | 34 | P2PKH output (value + script) |
| `TX_OVERHEAD` | 10 | Version + locktime + varint |
| `MIN_REQUEST_DELAY` | 200 | Milliseconds between WoC API calls |
| `MPT_PREFIX` | `[0x4d, 0x50, 0x54]` | "MPT" in ASCII |
| `MPT_VERSION` | `0x01` | Protocol version byte |

---

## localStorage Schema

| Key | Value | Purpose |
|-----|-------|---------|
| `mpt:wallet:wif` | WIF string | Private key persistence |
| `mpt:data:token:{tokenId}` | OwnedToken JSON | Token metadata |
| `mpt:data:proof:{tokenId}` | ProofChain JSON | Merkle proof chain |
