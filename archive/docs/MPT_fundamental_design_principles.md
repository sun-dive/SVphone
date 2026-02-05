## Merkle Proof Token
Feb 3, 2026

## Overview

The Merkle Proof Token (MPT) is a token protocol on BSV mainnet that uses P2PKH outputs for ownership and OP_RETURN outputs for metadata. Token validity is proven exclusively through Merkle proofs and block headers (SPV), with no dependency on UTXO lookups, indexers, or trusted third parties for verification.

## SPV Token Verification

An MPT token can be verified using only three pieces of data: the **Token ID**, the **genesis transaction ID**, and a **block header**.

### Token ID Derivation

The Token ID is a single SHA-256 hash over the concatenation of:

```
Token ID = SHA-256( genesisTxId || outputIndex_LE || tokenName || tokenScript || tokenRules || tokenAttributes )
```

- `genesisTxId`: 32 bytes, the hash of the genesis transaction
- `outputIndex_LE`: 4 bytes little-endian, the P2PKH output index in the genesis TX (starts at 1; output 0 is OP_RETURN)
- The remaining fields are the raw pushdata bytes of OP_RETURN chunks 2-5, concatenated in order

This is a purely local computation. No network access is required. If any immutable field has been tampered with, the recomputed Token ID will not match the claimed one.

### Merkle Proof Verification

Given the genesis transaction ID, the verifier obtains its Merkle proof -- an ordered list of sibling hashes that, combined with the transaction hash, reproduce the block's Merkle root.

Verification proceeds bottom-up: starting from the double-SHA-256 of the genesis transaction ID, the verifier concatenates each sibling hash (left or right, as indicated by the proof path) and double-SHA-256s the pair at each level. The final output is the computed Merkle root.

### Block Header Confirmation

The computed Merkle root is compared against the `hashMerkleRoot` field in the block header at the genesis transaction's confirmed height. A match proves the genesis transaction was included in that block. The block header itself is an 80-byte structure whose validity is established by its proof-of-work -- it must hash below the difficulty target for that height.

### Why Only the Genesis Transaction

Transfer transactions do not require independent block header verification. Each transfer spends the previous token UTXO as an input; miners validate that the input exists and is unspent before accepting the transaction into a block. A transfer transaction that references a non-existent or already-spent UTXO is rejected by the network. This is the Bitcoin UTXO model's built-in guarantee -- once a transfer is mined, its validity is implicit.

The genesis transaction is the only one that creates value from nothing (from the token protocol's perspective). Proving it was mined is sufficient to establish that the token's origin is legitimate and that all subsequent transfers were validated by miners through normal transaction processing.

## Token Lifecycle

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                     MPT TOKEN LIFECYCLE DIAGRAM                              ║
╚══════════════════════════════════════════════════════════════════════════════╝


  ┌─────────────────────────────────────────────────────────────────────────┐
  │                        1. GENESIS (MINT)                                │
  │                        Wallet A creates tokens                          │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   ▼
                  ┌───────────────────────────────────┐
                  │         Genesis Transaction       │
                  │                                   │
                  │  Input 0: Funding UTXO(s)         │
                  │          (Wallet A's BSV)         │
                  │                                   │
                  │  Output 0: OP_RETURN (0 sats)     │
                  │    ┌───────────────────────┐      │
                  │    │ "MPT" | version       │      │
                  │    │ tokenName             │      │
                  │    │ tokenScript           │      │
                  │    │ tokenRules            │      │
                  │    │ tokenAttributes       │      │
                  │    │ stateData             │      │
                  │    └───────────────────────┘      │
                  │                                   │
                  │  Output 1: P2PKH → Wallet A (1sat)│─── Token #1
                  │  Output 2: P2PKH → Wallet A (1sat)│─── Token #2
                  │  Output 3: P2PKH → Wallet A (1sat)│─── Token #3
                  │  ...                              │
                  │  Output N: P2PKH → Wallet A (1sat)│─── Token #N
                  │                                   │
                  │  [Optional: File OP_RETURN]       │
                  │  Output N+1: Change → Wallet A    │
                  └─────────────────┬─────────────────┘
                                    │
                                    ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                  2. RETURN TO MINTER'S WALLET                           │
  │                                                                         │
  │  Token ID = SHA-256(genesisTxId || outputIndex LE || immutable chunks)  │
  │                                                                         │
  │  Each token is stored with:                                             │
  │    • tokenId (derived, immutable)                                       │
  │    • genesisTxId + genesisOutputIndex (origin reference)                │
  │    • currentTxId + currentOutputIndex (spendable UTXO)                  │
  │    • All metadata fields (name, script, rules, attrs, state)            │
  │    • Proof chain: empty at genesis (no Merkle proof yet)                │
  │    • Status: "active"                                                   │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
            ▼                      ▼                      ▼
  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
  │  Transfer #1    │  │  Transfer #2    │  │  Transfer #N    │
  │  Token #1       │  │  Token #2       │  │  Token #N       │
  │  → Wallet B     │  │  → Wallet C     │  │  → Wallet D     │
  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘
           │                    │                     │
           ▼                    ▼                     ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                     3. TRANSFER TRANSACTION                             │
  │                     (one per token)                                     │
  │                                                                         │
  │  Input 0: Token UTXO (1 sat P2PKH, signed by Wallet A)                  │
  │  Input 1+: Funding UTXO(s) (Wallet A's BSV for miner fee)               │
  │                                                                         │
  │  Output 0: P2PKH → Recipient address (1 sat)  ← new token UTXO          │
  │  Output 1: OP_RETURN (0 sats)                                           │
  │    ┌───────────────────────────────────────┐                            │
  │    │ "MPT" | version                       │                            │
  │    │ tokenName                             │                            │
  │    │ tokenScript                           │                            │
  │    │ tokenRules                            │                            │
  │    │ tokenAttributes                       │                            │
  │    │ stateData                             │                            │
  │    │ ─── transfer-only fields ───          │                            │
  │    │ genesisTxId (32 bytes)                │                            │
  │    │ proofChain (binary bundle)            │                            │
  │    │ genesisOutputIndex (4 bytes LE)       │                            │
  │    └───────────────────────────────────────┘                            │
  │  Output 2: Change → Wallet A                                            │
  │                                                                         │
  │  Wallet A status: "pending_transfer" → "transferred"                    │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   │  Transaction broadcast to BSV network
                                   │  Miners validate and include in block
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                   4. RECIPIENT WALLET DETECTION                         │
  │                                                                         │
  │  Recipient wallet sees a 1-sat UTXO arrive                              │
  │                                                                         │
  │           ┌──────────────────────────────┐                              │
  │           │   1-sat UTXO quarantine zone │                              │
  │           │                              │                              │
  │           │  All 1-sat UTXOs land here   │                              │
  │           │  (could be tokens or dust)   │                              │
  │           └──────────────┬───────────────┘                              │
  │                          │                                              │
  │           Two detection paths:                                          │
  │           • Auto-import (fire-and-forget from quarantine)               │
  │           • Manual scan ("Check Incoming Tokens" button)                │
  │                          │                                              │
  │           ┌──────────────▼────────────────┐                             │
  │           │  Fetch TX, decode OP_RETURN   │                             │
  │           │  Check for "MPT" + v0x02      │                             │
  │           │  Check P2PKH pays to us       │                             │
  │           └──────────────┬────────────────┘                             │
  │                          │                                              │
  │                    Is it a valid MPT?                                   │
  │                     NO → skip (stays in quarantine)                     │
  │                     YES ↓                                               │
  └──────────────────────────┬──────────────────────────────────────────────┘
                             │
                             ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │                 5. SPV VERIFICATION GATE                                │
  │                 (before any token is accepted)                          │
  │                                                                         │
  │  Step 1: Recompute Token ID                                             │
  │    Token ID = SHA-256(genesisTxId || outputIndex LE || chunks[2..5])    │
  │    Computed ID must match claimed ID                                    │
  │    ✗ Mismatch → REJECT                                                  │
  │                                                                         │
  │  Step 2: Obtain Merkle proof                                            │
  │    Transfer TX: proof chain embedded in OP_RETURN                       │
  │    Genesis TX: fetch Merkle proof from network                          │
  │    ✗ No proof available (unconfirmed) → remains in quarantine           │
  │                                                                         │
  │  Step 3: Verify genesis Merkle proof                                    │
  │    Hash from txId through proof path → compute Merkle root              │
  │    (Bitcoin double SHA-256 at each level)                               │
  │    ✗ Invalid proof → REJECT                                             │
  │                                                                         │
  │  Step 4: Confirm against block header                                   │
  │    Fetch block header at genesis entry's height                         │
  │    Block header's Merkle root must match computed root                  │
  │    ✗ Mismatch → REJECT                                                  │
  │                                                                         │
  │  ✓ ALL CHECKS PASS → token accepted into wallet as "active"             │
  │                                                                         │
  │  ┌───────────────────────────────────────────────────────────────┐      │
  │  │ NOTE: Only the genesis TX's block header is checked.          │      │
  │  │ Transfer TXs are validated by miners when spent — their       │      │
  │  │ block inclusion is an implicit guarantee.                     │      │
  │  └───────────────────────────────────────────────────────────────┘      │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
                                   ▼
  ┌─────────────────────────────────────────────────────────────────────────┐
  │               6. TOKEN NOW ACTIVE IN RECIPIENT WALLET                   │
  │                                                                         │
  │  Stored with updated proof chain (includes all prior transfers)         │
  │  currentTxId points to the transfer TX (the spendable UTXO)             │
  │  genesisTxId still points to the original mint                          │
  │                                                                         │
  │  The recipient can now:                                                 │
  │    • Hold the token                                                     │
  │    • Transfer it to another wallet (cycle repeats from step 3)          │
  │    • Run "Verify" (retries genesis verification if incomplete)          │
  │    • Transfer it back to the original minter (return-to-sender)         │
  └────────────────────────────────┬────────────────────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
              ▼                    ▼                     ▼
    ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
    │  Transfer onward │ │  Return to       │ │  Manual Verify   │
    │  → Wallet E      │ │  Wallet A        │ │  (retry)         │
    │  (repeat step 3) │ │  (repeat step 3) │ │                  │
    │                  │ │                  │ │  Refreshes the   │
    │  Proof chain     │ │  Wallet A sees   │ │  same genesis    │
    │  grows by one    │ │  token return,   │ │  verification    │
    │  entry per       │ │  re-verifies,    │ │  when auto-check │
    │  transfer        │ │  status → active │ │  was incomplete  │
    └──────────────────┘ └──────────────────┘ └──────────────────┘


  ┌─────────────────────────────────────────────────────────────────────────┐
  │                     PROOF CHAIN GROWTH                                  │
  │                                                                         │
  │  Genesis (mint)     chain: []  (empty, proof fetched on demand)         │
  │       │                                                                 │
  │       ▼                                                                 │
  │  Transfer A→B       chain: [{ txId_A, block, root, path }]              │
  │       │                                                                 │
  │       ▼                                                                 │
  │  Transfer B→C       chain: [{ txId_B, ... }, { txId_A, ... }]           │
  │       │                      ▲ newest-first                             │
  │       ▼                                                                 │
  │  Transfer C→D       chain: [{ txId_C }, { txId_B }, { txId_A }]         │
  │                                                                         │
  │  Each transfer adds one entry. The oldest entry (last in array)         │
  │  always corresponds to the genesis TX.                                  │
  └─────────────────────────────────────────────────────────────────────────┘
```

**Network:** BSV Mainnet

---

## Token Design

An MPT token is a BSV transaction with a specific output structure. Ownership uses standard P2PKH locking scripts for token UTXOs. All token metadata lives in a separate OP_RETURN output. When a `tokenScript` is defined, the consensus script bytes are stored in the OP_RETURN and can be enforced by miners via techniques like OP_PUSH_TX; the P2PKH outputs themselves remain standard.

## Token Verification Flow

A token is accepted into the wallet only after passing SPV verification. This applies to all incoming tokens — whether detected automatically from quarantined UTXOs, found during a manual scan, or returning from a previous transfer.

### On Import (automatic gate)

When the wallet encounters an incoming token:

1. **Token identity check:** Recompute the Token ID from the claimed genesis transaction, output index, and immutable metadata fields (name, script, rules, attributes). If the computed ID doesn't match the claimed ID, the token is rejected.

2. **Obtain the Merkle proof:** If the token arrives via a transfer, the proof chain is embedded in the OP_RETURN data. If it's a genesis transaction with no proof chain yet, the wallet fetches the Merkle proof from the network. If no proof is available (transaction not yet confirmed), the token remains in quarantine until a future scan.

3. **Verify the genesis transaction was mined:** Using the Merkle proof for the genesis transaction, the wallet computes the Merkle root by hashing from the transaction ID up through the proof path using Bitcoin's double SHA-256. The computed root must match the root claimed in the proof entry.

4. **Confirm against the block header:** The wallet fetches the block header at the genesis transaction's block height and confirms that the block's Merkle root matches the one computed from the proof. This proves the genesis transaction was included in an actual mined block.

Only the genesis transaction's block header is required. Transfer transactions are already validated by miners when they are spent, so their inclusion in a block is an implicit guarantee.

### On Manual Verify (retry)

When the user clicks "Verify," the wallet refreshes the same genesis-only verification procedure. This is used when the automated import could not complete verification (e.g. transaction not yet confirmed, network timeout, or time budget exceeded). The manual action queues the token for another verification pass using the same steps described above.

## Token Data Fields

### Immutable Fields

All immutable fields are cryptographically bound to the Token ID. Tampering with any of them causes a Token ID mismatch -- instant verification failure. No additional checking logic needed for these fields; the existing `computeTokenId` check catches it.

**[Token ID]**
- `SHA-256(genesisTxId || outputIndex LE || opReturnChunks[2..5] raw bytes)`
- Deterministic, purely local computation. No network access required.
- `outputIndex` is the actual Bitcoin output index of the token's P2PKH in the genesis TX. Since Output 0 is the OP_RETURN, token indices start at 1. Single mint = 1, batch mint = 1..N.
- `opReturnChunks[2..5]` binds the shared collection identity (name, script, rules, attributes).

**[Token Name]**
- UTF-8 text string.
- Shared across all tokens in the genesis transaction. Identifies the NFT set.
- Immutable after genesis. Included in Token ID computation.

**[Token Script]** (default: empty)
- Optional field for additional miner-enforced consensus rules.
- Empty (zero-length pushdata) = no additional consensus rules; token ownership is enforced solely by the P2PKH output's standard 25-byte locking script (`OP_DUP OP_HASH160 <pubkeyhash> OP_EQUALVERIFY OP_CHECKSIG`).
- When non-empty, contains raw Bitcoin Script bytes defining extra validation constraints (e.g. issuer co-sign, Merkle whitelist, time locks, state mutation constraints).
- Immutable after genesis. Included in Token ID computation.

**[Token Rules]**
- Arbitrary structured data defining token behaviour (application-level, wallet-enforced).
- The protocol does not prescribe a specific format — this field is flexible and can contain any binary data meaningful to the issuing application.
- Immutable after genesis. Included in Token ID computation.

**Example implementation (v05 prototype):** 8 bytes encoding supply, divisibility, restrictions, and version:
  - **Supply** (uint16): Total number of whole tokens minted in this genesis transaction.
  - **Divisibility** (uint16): Fragments per whole token. 0 = NFT/indivisible.
  - **Restrictions** (uint16): Bitfield for wallet-enforced conditions.
  - **Version** (uint16): Allows future rule extensions.

**[Token Attributes]** (default: empty)
- Immutable data shared by all tokens in the NFT set. Set at genesis. If unused, the chunk is a zero-length pushdata (the chunk must still be present for positional parsing).
- All tokens within a single genesis TX have identical attributes.
- For tokens with different attributes (e.g. different rarity tiers), use separate genesis TXs (separate NFT sets).
- When a file is embedded, tokenAttributes contains the SHA-256 hash of the file (32 bytes). The full file data lives in a separate OP_RETURN output in the genesis TX only (see Embedded File Data section).
- Examples: rarity tier, trait set, content hash, collection metadata, SHA-256 file hash.

### Mutable Fields **

Checked by wallet application against Token Rules. Can be updated by the wallet app as well as on each transfer.

**[State Data]** (default: 0x00)
- Arbitrary bytes, minimum 1 byte. Usage defined by Token Rules.
- Always present (required for positional chunk parsing to distinguish genesis from transfer TXs).
- Examples: metadata hash, counter, status flag, IPFS CID.
