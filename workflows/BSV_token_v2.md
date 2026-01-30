## Merkle Proof Token (MPT) v2

## Overview

A UTXO-based token on the Bitcoin SV blockchain. Token identity is tied to a specific UTXO, with provenance verified through a chain of Merkle proofs — no indexer required.

Genesis is a two-transaction process: create then finalise. Transfers are single-transaction spends that carry forward immutable fields and update mutable state.

---

## Token Data Fields

### Immutable Fields
Set at genesis, enforced by script on every spend. Must be byte-identical across all transfers.

**[Token ID]**
- SHA-256(Genesis TXID || Output Index)
- Uniquely identifies this token. Derived after the genesis TX is broadcast.

**[Token Name]**
- UTF-8 text string.
- Human-readable label. Tokens sharing a name form a collection but remain independently identified by Token ID.

**[Token Rules]**
- Structured data defining token behaviour:
  - **Supply:** Total unit count. 1 = NFT, >1 = fungible.
  - **Divisibility:** Decimal places. 0 = indivisible.
  - **Transfer Restrictions:** Unrestricted, whitelist, time-lock, or custom script conditions.
  - **Version:** Integer. Allows future rule extensions.

**[Merkle Proof Genesis Hash]**
- Hash of the Merkle proof for the genesis TX.
- Set to null in the genesis TX. Set to the actual value in the finalisation TX. Immutable thereafter.

### Mutable Fields
Updated on each transfer. Validated by script according to Token Rules.

**[Owner ID]**
- Public key of the current token holder.

**[State Data]** (optional)
- Arbitrary bytes. Usage defined by Token Rules.
- Examples: metadata hash, counter, status flag, IPFS CID.

---

## Script Structure

The token UTXO output script follows this template:

```
<immutable_fields> OP_DROP <mutable_fields> OP_DROP <locking_script>
```

**Immutable fields:** Token ID, Token Name, Token Rules, Merkle Proof Genesis Hash — serialised and pushed as a single data blob.

**Mutable fields:** Owner ID, State Data — serialised and pushed as a single data blob.

**Locking script** enforces:
1. Signature verification against the current Owner ID.
2. Sighash preimage introspection to read the output script of the spending TX.
3. Byte comparison: immutable field segment in the new output must exactly match the current output.
4. Mutable field validation per Token Rules (e.g. conservation of supply for fungible tokens).

---

## Genesis

### Step 1 — Genesis TX
Wallet A creates a transaction with:
- **Input:** A funding UTXO with enough satoshis to cover fees and at least 1 sat for the token output.
- **Output 0 (Token):** Script containing all token data fields. Merkle Proof Genesis Hash is set to null. Owner ID is Wallet A's public key.
- **Output 1 (Change):** Any remaining satoshis returned to Wallet A (non-token UTXO).

Wallet A broadcasts the transaction to the network.

### Step 2 — Confirmation
The genesis TX is mined into a block. Wallet A obtains the Merkle proof for the genesis TX from the block.

Wallet A computes:
- **Token ID** = SHA-256(Genesis TXID || 0)
- **Merkle Proof Genesis Hash** = Hash of the genesis TX Merkle proof

### Step 3 — Finalisation TX
Wallet A spends the genesis UTXO into a new UTXO:
- **Input 0:** The genesis token UTXO (Output 0 from Step 1).
- **Input 1:** A funding UTXO for fees.
- **Output 0 (Token):** Identical to genesis except:
  - Token ID is now populated.
  - Merkle Proof Genesis Hash is set to the computed value.
- **Output 1 (Change):** Fee change returned to Wallet A.

This is the finalised token. All immutable fields are now locked. The Merkle Proof Genesis Hash will be enforced byte-for-byte on every future spend.

---

## Transfers

### Wallet A transfers to Wallet B

Wallet A creates a transaction:
- **Input 0:** The current token UTXO.
- **Input 1:** A funding UTXO for fees (separate from the token UTXO).
- **Output 0 (Token):** New token UTXO with:
  - All immutable fields unchanged (enforced by script).
  - Owner ID set to Wallet B's public key.
  - State Data updated if applicable per Token Rules.
- **Output 1 (Change):** Fee change returned to Wallet A.

Wallet A provides Wallet B with the **proof chain**:
- The chain of Merkle proofs from genesis to the current transfer.
- Each proof links a transaction to a block header.

### Wallet B verifies the token

1. Start from the most recent Merkle proof, verify it against the corresponding block header.
2. Walk backward through each prior transfer's Merkle proof, verifying each against its block header.
3. Confirm the chain terminates at the genesis TX whose Merkle proof hashes to the Merkle Proof Genesis Hash in the token data.
4. Confirm immutable fields are consistent across every transaction in the chain.
5. Broadcast the transfer TX to transaction processors for inclusion in the next block.

Wallet B now holds the token UTXO and the full proof chain, which it will extend and pass on in any future transfer.

---

## Collections

Tokens sharing a Token Name form a collection. Each token in a collection:
- Has its own unique Token ID (derived from its own genesis TXID).
- Has its own independent UTXO and proof chain.
- May share identical Token Rules or vary per token.

There is no on-chain link between collection members. The shared Token Name is the only grouping mechanism. Applications can index by Token Name to display collections.

---

## Fee Handling

Token UTXOs carry exactly 1 satoshi — the minimum for a valid UTXO. Transaction fees are always paid by a **separate funding UTXO** provided as an additional input. This keeps the token UTXO clean and avoids mixing fee funds with token state.
