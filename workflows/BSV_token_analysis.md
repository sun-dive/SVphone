## MPT (Merkle Proof Token) — Analysis & Proposed Improvements

## Summary

The current spec defines a two-transaction genesis flow for creating a UTXO-based token on BSV, with transfers verified via Merkle proofs. The core idea is sound — token identity tied to UTXOs with SPV-verifiable provenance. The following analysis identifies gaps, ambiguities, and improvements.

---

## Analysis

### Strengths

1. **UTXO-native identity** — Token exists as a UTXO, making it self-contained and SPV-compatible.
2. **Merkle proof chain** — Provenance is verifiable without a full node or indexer.
3. **Two-transaction genesis** — Separates creation from finalization, allowing the Merkle proof of the genesis TX to be embedded in the token.
4. **Immutable rules** — Token Rules are defined at genesis and carried forward.

### Issues & Gaps

#### 1. Token ID Generation
- **Problem:** Token ID is derived from Token Name + private key + Token Rules. Including the private key in a hash is unusual and risky — it implies the private key must be known at verification time to recompute the ID, or the ID becomes an opaque value that can't be independently verified.
- **Ambiguity:** What hash function? SHA-256? Double SHA-256? The spec doesn't say.

#### 2. Immutable vs Mutable Fields Not Defined
- **Problem:** The spec lists Token Rules as "immutable rules defining the token" but doesn't specify which fields are immutable and which are mutable. From our earlier discussion, positional script enforcement is the mechanism — but this isn't described.
- **Missing:** No definition of what Token Rules actually contains (supply cap, divisibility, transfer restrictions, etc.).

#### 3. Genesis Flow Ambiguity
- **Step 2** says "Wallet sends transaction to itself" — this is the same as Step 1. It's unclear whether Step 1 and Step 2 are the same transaction or separate actions.
- **Step 3** says "modifies token data" — but token data lives in a UTXO script, which is immutable once created. This actually means spending the genesis UTXO and creating a new one with the Merkle proof hash included. The language should reflect this.
- **Step 4** appears to be the second transaction that spends the updated UTXO. The distinction between Steps 3 and 4 is unclear.

#### 4. Transfer Section
- **Formatting issue:** Line 41 has all fields concatenated without separators: `Token IDToken NameNew Owner ID...`
- **Missing:** No description of how the locking script enforces carry-forward of immutable fields during transfer.
- **Missing:** No mention of what happens to the sender's state — does Wallet A's UTXO get fully consumed, or is there a change output?
- **Missing:** No specification of how Wallet B constructs and validates the Merkle proof chain.

#### 5. No Script/Contract Definition
- The spec describes data fields but not the actual script structure or opcodes used. Without this, there's no enforcement mechanism — just a data format.

#### 6. No Supply or Divisibility Model
- Can a token be split (fractional transfers)?
- Is there a fixed supply defined at genesis?
- Can multiple tokens share a Token Name (the spec hints at this with "another token in a series")?

#### 7. Fee Handling
- The spec mentions "enough sats to pay tx fees" but doesn't address where fee funding UTXOs come from or how they're separated from the token UTXO.

---

## Proposed Improvements

### 1. Fix Token ID Derivation
Replace private key with the **genesis TXID** as the unique identifier:
```
Token ID = SHA-256(Genesis TXID || Output Index)
```
This is deterministic, publicly verifiable, and unique per token. No private key exposure.

### 2. Define Field Mutability Explicitly
Split the token data into two clearly separated sections:

**Immutable (enforced by script on every spend):**
- Token ID
- Token Name
- Token Rules (supply cap, decimal precision, transfer restrictions)
- Merkle Proofs Genesis Hash (set in finalisation TX)

**Mutable (changeable per transfer):**
- Owner ID (public key of current holder)
- Balance (if divisible)
- State data (optional, contract-defined)

### 3. Clarify the Genesis Flow
Rewrite as:

1. **Genesis TX** — Wallet A creates a transaction with an output containing the token data fields. Merkle Proofs Genesis Hash is set to null. TX is broadcast.
2. **Wait for confirmation** — TX is mined into a block. Wallet A obtains the Merkle proof for the genesis TX from the block header.
3. **Finalisation TX** — Wallet A spends the genesis UTXO into a new UTXO that is identical except the Merkle Proofs Genesis Hash is now set to the hash of the genesis TX's Merkle proof. This is the canonical token UTXO.

### 4. Define the Script Structure
Specify a script template:
```
<immutable_data> OP_DROP <mutable_data> OP_DROP <locking_script>
```
Where `<locking_script>`:
- Verifies the spending transaction signature
- Uses sighash preimage introspection to read the output script of the spending TX
- Enforces that the immutable_data bytes are identical in the new output
- Allows mutable_data to change according to Token Rules

### 5. Expand Transfer Specification
A transfer from Wallet A to Wallet B should specify:
1. Wallet A creates a TX spending the token UTXO
2. Output 0: New token UTXO with Owner ID changed to Wallet B's public key, all immutable fields preserved
3. Output 1 (optional): Change output for fee funding (non-token UTXO)
4. Input for fees: A separate non-token UTXO to cover miner fees
5. Wallet A provides Wallet B with the chain of Merkle proofs (genesis proof + all intermediate transfer proofs)
6. Wallet B validates by: checking each Merkle proof against block headers, verifying immutable fields are consistent across the chain, confirming the chain starts at the Merkle Proofs Genesis Hash

### 6. Define Token Rules Content
Token Rules should be a structured data object containing at minimum:
- **Supply cap** — total number of tokens (1 for NFT, >1 for fungible)
- **Divisibility** — number of decimal places (0 for indivisible)
- **Transfer restrictions** — e.g., whitelist, time-locks, or unrestricted
- **Version** — to allow future rule extensions

### 7. Address Series/Collection Tokens
Clarify the "series" concept: if multiple tokens share a Token Name, define how they relate. Options:
- Shared Token Name with unique Token IDs (collection model)
- A master token that issues child tokens (hierarchical model)
- Independent tokens that happen to share a name (no formal relationship)
