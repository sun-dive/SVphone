# Consensus-Level Scripts for MPT -- Research Summary

February 2nd, 2026

## Context

MPT v04 uses P2PKH for ownership and OP_RETURN for metadata. All token rules (transfer restrictions, state mutation, supply) are enforced at the application/wallet level only. This document explores adding miner-enforced consensus scripts as a new immutable element in the MPT protocol.

---

## BSV Script Capabilities (Post-Genesis Upgrade, Feb 2020)

The Genesis upgrade restored Bitcoin Script to its original design:

- **All opcodes restored**: OP_CAT, OP_SPLIT, OP_MUL, OP_DIV, OP_MOD, OP_AND, OP_OR, OP_XOR, OP_LSHIFT, OP_RSHIFT, OP_INVERT, OP_NUM2BIN, OP_BIN2NUM
- **No script size limit** at consensus level (protocol allows up to ~4 GB; miner policy default ~10 KB, can be raised)
- **No opcode count limit** (previously 500)
- **BigNum arithmetic** with operands up to 750,000 bytes (replaces old 4-byte integer limit)
- **P2SH removed** -- all scripts evaluated directly
- **OP_CLTV/OP_CSV reverted to NOP** -- time locks must use preimage inspection instead

This makes BSV Script Turing-complete (bounded by UTXO lifecycle).

---

## Key Technique: OP_PUSH_TX (Transaction Introspection)

OP_PUSH_TX is not an opcode but a technique using OP_CHECKSIG to prove a BIP143 sighash preimage is genuine. Once verified, the script can parse the preimage to inspect:

| Field | Use for Token Logic |
|-------|-------------------|
| **scriptCode** | Contains the locking script (immutable contract data) |
| **value** | Satoshi amount of input (1 sat for tokens) |
| **hashOutputs** | Hash commitment to ALL outputs -- enforces output script content |
| **nLocktime** | Transaction locktime -- enables time-lock enforcement |

The "build and compare" pattern: construct the expected output script, hash it, compare to hashOutputs from the preimage. If they match, the transaction's outputs are exactly as specified. Miners enforce this.

---

## sCrypt Smart Contracts

sCrypt is a TypeScript-based DSL that compiles to native Bitcoin Script. Key patterns:

- **`@prop()`** -- Immutable fields compiled into the script's "code" section. Cannot change between spends. Miner-enforced immutability.
- **`@prop(true)`** -- Mutable state appended to the script. Can change but must satisfy validation logic.
- **`buildStateOutput()`** -- Constructs the expected next output (same code + new state). The `hashOutputs` check forces the spending TX to match exactly.
- **`ANYONECANPAY_SINGLE`** sighash -- Allows additional inputs (fees) and outputs (change) without breaking the hash commitment for the token output.

MPT already has an sCrypt contract (`src/contracts/mpt.ts`) implementing this pattern with immutable tokenName/tokenRules/tokenAttributes and mutable ownerPubKey/stateData.

---

## Existing BSV Token Protocols Using Consensus Scripts

| Protocol | Approach | Back-to-Genesis |
|----------|----------|-----------------|
| **STAS** | Token value = satoshi amount; compact scripts enforce transfer rules; L0 miner enforcement | Requires indexer/oracle |
| **Sensible Contract** | OP_PUSH_TX introspection; state in locking script | Oracle-based |
| **1Sat Ordinals + sCrypt** | Ordinal satoshis locked in sCrypt contracts; permissioned transfers via issuer co-sign | Ordinal tracking |
| **sCrypt Merkle Token** | Balance table as Merkle tree; only root stored on-chain; O(log n) proof per transfer | In-script verification |

All face the **back-to-genesis problem**: consensus scripts enforce each transition but cannot alone prove provenance back to genesis. MPT's Merkle proof chain solves this via SPV -- a significant advantage.

---

## Practical Patterns for MPT

### A. Issuer Co-Sign (Simplest Whitelist)

The issuer must co-sign every transfer. Whitelist maintained off-chain.

```
transfer(ownerSig, issuerSig, newOwner, ...) {
    verify ownerSig against current owner
    verify issuerSig against immutable issuerPubKey
    propagate state
}
```

Cost: ~200 extra bytes (one additional OP_CHECKSIG). No on-chain data structures needed.

### B. Merkle Whitelist (Decentralized)

Whitelist stored as immutable Merkle root at genesis. Transfer requires Merkle proof that recipient is whitelisted.

```
transfer(ownerSig, newOwner, merklePath, ...) {
    verify ownerSig
    verify merklePath proves newOwner is in whitelist tree
    propagate state
}
```

Cost: ~500-2000 bytes depending on tree depth. Whitelist is immutable after genesis.

### C. State Mutation Rules

Enforce state transitions at consensus level (e.g., counter must increment, status can only move forward).

```
transfer(ownerSig, newOwner) {
    verify ownerSig
    this.counter = this.counter + 1   // miner enforces increment
    propagate state with hashOutputs check
}
```

Cost: ~100-400 extra bytes. State validation logic is part of the immutable code section.

### D. Time Locks (via Preimage)

Since OP_CLTV is a NOP on BSV, time locks use nLocktime from the sighash preimage.

```
transfer(ownerSig, newOwner, ...) {
    verify ownerSig
    assert nLocktime >= immutable unlockTime
    propagate state
}
```

Cost: ~50-150 extra bytes.

### E. Rule Dispatch (Extensible)

A `consensusRuleType` field in the immutable section selects which validation logic applies:

```
@prop() consensusRuleType: bigint   // 0=none, 1=whitelist, 2=timelock, 3=counter

transfer(...) {
    if ruleType == 1: verify whitelist proof
    if ruleType == 2: verify timelock
    if ruleType == 3: verify counter increment
    propagate state
}
```

All rule types compiled into the script; the immutable type field selects which branch executes.

---

## Trade-offs

### Benefits

- **Trustless enforcement**: Miners reject invalid transfers. No reliance on wallet software.
- **Auditability**: Rules readable directly from the locking script.
- **Composability**: Other contracts can trust the token's behavior (atomic swaps, escrow, DEX).
- **Reduced verification burden**: SPV verifiers know miners already enforced transition rules.
- **Negligible cost**: At ~1 sat/KB, even a 5 KB contract costs ~5 satoshis per transfer.

### Costs / Limitations

- **True immutability**: Consensus rules cannot be changed after genesis. Must be designed carefully.
- **Back-to-genesis still needs MPT's proof chain**: Consensus scripts enforce each transition but not full provenance. MPT's Merkle proof chain remains essential.
- **Unlocking script overhead**: OP_PUSH_TX requires ~180+ bytes of sighash preimage per spend.
- **Miner policy limits**: Default ~10 KB script policy (miners can raise). Most token contracts are well under this.
- **No OP_CLTV/OP_CSV**: Time locks work via preimage inspection but are more verbose.
- **Script complexity**: More validation logic = larger scripts, more testing, harder auditing.

---

## Recommendation

MPT is well-positioned for consensus enforcement because:

1. **Already uses sCrypt** -- the existing contract implements stateful immutable/mutable field separation
2. **Proof chain solves back-to-genesis** -- unlike STAS/Sensible which need external indexers
3. **Cost is negligible** -- BSV fees make script size a non-issue
4. **Incremental approach possible** -- start with issuer co-sign (~200 bytes), layer complexity later

**Suggested first step**: Add an immutable `consensusRuleType` field and `issuerPubKey` to the sCrypt contract. When `restrictions` bitfield indicates whitelist, require issuer co-signature. This provides genuine miner-enforced access control with minimal added complexity.

**Approximate script sizes:**

| Configuration | Script Size | Fee Impact |
|--------------|------------|------------|
| No consensus rules (current) | ~200-500 B | baseline |
| + Issuer co-sign | ~400-700 B | +0.2 sat |
| + Merkle whitelist | ~700-2000 B | +0.5-2 sat |
| + State mutation + timelock | ~600-1200 B | +0.4-1 sat |
| Full multi-rule contract | ~1-5 KB | +1-5 sat |
