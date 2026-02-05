# Comparison: fundamental_design_principles.md vs. v05_00_structure_and_function.md

**Date:** February 3, 2026
**Purpose:** Identify alignment issues and provide recommendations for updating the fundamental_design_principles document to reflect v05 changes.

---

## ⚠️ CRITICAL BUG FIX DISCOVERED AND APPLIED

**Important:** During the creation of this document, a critical bug was discovered in the v05 implementation:

**THE BUG:** tokenAttributes was incorrectly included in the Token ID computation.

**THE FIX (Applied - Commit 1cffb8d):**
- `buildImmutableChunkBytes()` now includes ONLY: tokenName + tokenScript + tokenRules
- tokenAttributes is MUTABLE and NOT bound to Token ID
- This allows tokenAttributes to be updated on each transfer without affecting token identity

**Impact on these recommendations:** Sections RECOMMENDATION 1, 4, 5, and 10 have been CORRECTED to reflect the proper design. The original document was comparing against incorrect v05 code.

---

## Executive Summary

The fundamental_design_principles.md document is a solid concise overview (~326 lines) that covers the essential MPT concepts well. However, it was written before several critical updates in v05:

1. **Terminology unification** around `immutableChunkBytes` (instead of `opReturnChunks[2..5]`)
2. **Explicit documentation** of the encoder/parser chunk index offset (critical for understanding the implementation)
3. **More detailed explanations** of Token Rules fields including max values
4. **Divisibility terminology** introduced in SPV verification examples

The v05 document now comprehensively documents these changes. The fundamental_design_principles should be updated to align, maintaining its concise nature while reflecting the current v05 implementation.

---

## Detailed Recommendations

### RECOMMENDATION 1: Unify Token ID Terminology (Line 17)

**Current (fundamental):**
```
Token ID = SHA-256( genesisTxId || outputIndex_LE || tokenName || tokenScript || tokenRules || tokenAttributes )
```

**Updated (v05):**
```
Token ID = SHA-256(genesisTxId || outputIndex LE || immutableChunkBytes)
where immutableChunkBytes = tokenName + tokenScript + tokenRules
```

**IMPORTANT NOTE:** tokenAttributes is **MUTABLE** and NOT included in Token ID computation. This is critical for allowing tokenAttributes to be updated without changing token identity.

**Why change:**
- The v05 document now uses consistent `immutableChunkBytes` terminology (name + script + rules ONLY)
- Cleaner and more recognizable as "the immutable chunk concatenation"
- Aligns with terminology in critical code comments documenting the chunk offset bug fix
- The concatenation concept is more intuitive than listing fields
- **Critical:** tokenAttributes exclusion allows it to be mutable and updated on each transfer

**Impact on document:**
- Update line 17 to use immutableChunkBytes notation
- Add a brief explanation: "These are the concatenated raw bytes of the immutable fields bound to the token's identity"
- Update line 22 which currently says "opReturnChunks[2..5]" to use "immutableChunkBytes" instead

---

### RECOMMENDATION 2: Add Note on Chunk Index Offset (New section, before line 26)

**Current:** No mention of encoder vs. parser chunk indices

**Should add (similar to v05 lines 145-146):**
```
**Technical Note on Chunk Indices:**
The OP_RETURN script contains OP_0 and OP_RETURN opcodes at positions [0] and [1].
When parsing, these are stripped, so data chunk indices are offset by 2:
encoder [2] → parser [0], encoder [3] → parser [1], etc.
This distinction is critical for understanding the codec implementation.
```

**Why add:**
- This offset caused the critical bugs discovered in testing (fragment transfers not appearing)
- Technical readers need to understand this to avoid confusion when reading codec.ts
- Makes the fundamental document more useful for implementers
- Clarifies the "why" behind some of the codec logic

**Impact on document:**
- Brief but important clarification for technical audience
- ~4-5 lines added before "### Merkle Proof Verification"

---

### RECOMMENDATION 3: Clarify tokenRules Field Values (Lines 305-309)

**Current (fundamental):**
```
- **Supply** (uint16): Total number of whole tokens minted in this genesis transaction.
- **Divisibility** (uint16): Fragments per whole token. 0 = NFT/indivisible.
- **Restrictions** (uint16): Bitfield for wallet-enforced conditions.
- **Version** (uint16): Allows future rule extensions.
```

**Should enhance with (from v05 lines 44-49):**
```
- **Supply** (uint16): Total number of whole tokens minted in this genesis transaction (max 65535).
- **Divisibility** (uint16): Number of fragments per whole token. 0 = NFT/indivisible. When > 0, the genesis TX mints supply * divisibility fragment UTXOs.
- **Transfer Restrictions** (uint16): Unrestricted, whitelist, time-lock, or custom wallet-enforced conditions.
- **Version** (uint16): Integer. Allows future rule extensions.
```

**Why change:**
- Provides concrete max value (65535) helps readers understand scale
- Clarifies behavior when divisibility > 0 (creates supply * divisibility fragments)
- Renaming to "Transfer Restrictions" is more precise than just "Restrictions"
- Better alignment with actual implementation

**Impact on document:**
- Improves clarity for technical readers
- 1-2 lines added per field
- No structural changes needed

---

### RECOMMENDATION 4: Enhance Token Attributes Field (Lines 311-317)

**Current:** Incorrectly describes tokenAttributes as immutable - NEEDS CORRECTION

**Should change to (from v05 correct design):**
- Explicitly state that tokenAttributes is **MUTABLE** (NOT immutable or bound to Token ID)
- Can be updated on each transfer without affecting token identity
- Clarify that when unused, it must still be present as zero-length pushdata for positional parsing
- Emphasize "If a file is embedded, tokenAttributes contains the SHA-256 hash of the file (32 bytes)" -- hash allows verification but is MUTABLE

**Why change:**
- **CRITICAL:** Current documentation incorrectly marks tokenAttributes as immutable. It is mutable and NOT part of Token ID.
- This was discovered and fixed in the codebase (buildImmutableChunkBytes now only includes name + script + rules)
- Zero-length pushdata requirement is important for codec implementers
- File hash verification (SHA-256 comparison) provides security while allowing mutability

**Impact on document:**
- ~3-4 lines of enhancement
- Maintains concise structure while adding clarity

---

### RECOMMENDATION 5: Update SPV Verification Algorithm (Lines 169-172)

**Current (line 170):**
```
Token ID = SHA-256(genesisTxId || outputIndex LE || chunks[2..5])
```

**Should update to:**
```
Token ID = SHA-256(genesisTxId || outputIndex LE || immutableChunkBytes)
where immutableChunkBytes = tokenName + tokenScript + tokenRules
```

**Why change:**
- Consistency with other occurrences in the document
- Avoids confusion with "chunks[2..5]" which could mean encoder or parser indices
- immutableChunkBytes is now the standard term across all documentation
- **IMPORTANT:** tokenAttributes is NOT included (it is mutable)

**Impact on document:**
- Single line update
- No structural changes

---

### RECOMMENDATION 6: Add Divisibility Example in Token Lifecycle

**Current (lines 99-106):** Token lifecycle shows individual token transfers

**Should add:** Brief example or reference showing what happens with divisible tokens

**Suggested addition (after line 104 or in new subsection):**
```
**Note on Divisible Tokens:**
When divisibility > 0, each output index (1 through supply * divisibility) represents a fragment with its own Token ID.
Example: supply=3, divisibility=2 creates 6 fragment UTXOs:
  - Output 1 = NFT 1, piece 1/2
  - Output 2 = NFT 1, piece 2/2
  - Output 3 = NFT 2, piece 1/2
  - Output 4 = NFT 2, piece 2/2
  - Output 5 = NFT 3, piece 1/2
  - Output 6 = NFT 3, piece 2/2
Each fragment can be transferred independently and is tracked with its own Token ID.
```

**Why add:**
- Divisibility is a core feature and technical readers should understand it early
- Clarifies that fragments are distinct tokens with unique Token IDs
- Helps readers understand the fragment transfer mechanics mentioned in later sections

**Impact on document:**
- ~8-10 lines added
- Could be a subsection or inline note
- Significantly improves completeness for readers unfamiliar with divisibility

---

### RECOMMENDATION 7: Clarify Return-to-Sender Verification (Lines 209-210)

**Current:** Mentions return-to-sender but doesn't detail verification process

**Should note (from v05 lines 365-375):**
```
When a token is returned to the original wallet:
1. The receiving wallet detects the incoming transfer
2. Performs full SPV verification (Token ID check, genesis Merkle proof, block header confirmation)
3. If the token already exists with status 'transferred' or 'pending_transfer', reactivates it as 'active'
4. Updates the UTXO details to point to the new transfer
This ensures returned tokens are verified with the same rigor as new arrivals.
```

**Why add:**
- Clarifies that return-to-sender is not an exception to verification rules
- Technical readers need to understand that verification is always performed
- Important for security understanding

**Impact on document:**
- ~5-6 lines of clarification
- Could be added after the return-to-sender box or in a separate note

---

### RECOMMENDATION 8: Enhance genesisOutputIndex Terminology (Throughout)

**Current:** Document mentions outputIndex but doesn't consistently distinguish between genesis and current

**Should clarify (from v05 lines 752-754):**
```
- genesisOutputIndex: The P2PKH output index in the genesis TX (1-based). Never changes across transfers.
  For batch/divisible tokens: 1..N or 1..S*D
- currentOutputIndex: The current UTXO output index. For genesis TXs: equals genesisOutputIndex.
  After first transfer: always 0 (P2PKH outputs are always Output 0 in transfer TXs)
```

**Why clarify:**
- The distinction is critical for understanding transfer mechanics
- Was a source of bugs in v05 (the genesisOutputIndex bug fix)
- Helps explain why fragments need the genesisOutputIndex embedded in transfer OP_RETURNs

**Impact on document:**
- Could be added as a subsection in "Token Data Fields"
- ~5-6 lines
- Significantly improves understanding for implementers

---

### RECOMMENDATION 9: Add Note on Proof Chain Storage (Around line 234-244)

**Current:** Explains proof chain growth well

**Should add:** Clarification from v05 about how proof chain is transported

```
**Important:** The proof chain is embedded in each transfer TX's OP_RETURN as binary data.
This means the complete verification history travels with the token.
The recipient can verify the entire chain from on-chain data alone without any indexer or API.
For genesis TXs with multiple fragments, the same genesis proof is referenced by all fragments via genesisTxId.
```

**Why add:**
- Clarifies the "travels with the token" concept
- Emphasizes the SPV-only philosophy
- Explains why genesisOutputIndex is necessary (to distinguish which fragment it is)

**Impact on document:**
- ~5 lines
- Reinforces a key architectural principle

---

### RECOMMENDATION 10: Clarify File Hash Binding (Around line 315)

**Current (line 315):** "tokenAttributes contains the SHA-256 hash of the file"

**Should enhance (with CORRECTION):**
```
When tokenAttributes contains a file hash:
- The 32-byte hash is stored in tokenAttributes (which is mutable, not bound to Token ID)
- Transfer TXs carry only the hash (not the full file)
- The full file data exists only in the genesis TX's separate OP_RETURN
- Wallet caches files locally in IndexedDB for fast retrieval even if genesis TX is pruned
- File verification: compute SHA-256(file bytes) and compare to stored hash
```

**Why clarify:**
- Explains the hash-on-chain, data-in-genesis design pattern
- **IMPORTANT CORRECTION:** Hash is stored in mutable field (not bound to Token ID)
- Clarifies that file size doesn't increase transfer TX cost
- Shows how the design elegantly handles OP_RETURN pruning
- File verification provides integrity without binding hash to token identity

**Impact on document:**
- ~5-6 lines
- Could be expanded section in "Token Data Fields"
- Improves understanding of embedded file design

---

## Non-Recommendations (Features Adequately Covered)

These v05 features are already well-represented in fundamental_design_principles.md:

- **Token Script field existence** (lines 294-298) ✓ Adequate
- **Architecture diagram** (lines 419-443) ✓ Still accurate
- **Lifecycle overview** (lines 44-245) ✓ Well structured
- **Token verification flow** (lines 255-275) ✓ Clear
- **Immutable vs. mutable fields** (lines 279-326) ✓ Well explained
- **UTXO Quarantine concept** (implied) ✓ Appropriate for fundamental level
- **Return-to-sender concept** (lines 218-225) ✓ Visually clear

---

## Prioritization

If not all recommendations can be implemented immediately:

**HIGH PRIORITY (Essential for v05 alignment):**
1. Recommendation 1: Token ID terminology → immutableChunkBytes
2. Recommendation 5: Update SPV verification algorithm
3. Recommendation 2: Add chunk index offset note

**MEDIUM PRIORITY (Important for technical accuracy):**
4. Recommendation 8: Clarify genesisOutputIndex vs currentOutputIndex
5. Recommendation 6: Add divisibility example
6. Recommendation 3: Enhance Token Rules field values

**NICE-TO-HAVE (Improve implementation clarity):**
7. Recommendation 4: Enhance Token Attributes field
8. Recommendation 7: Clarify return-to-sender verification
9. Recommendation 9: Add proof chain storage note
10. Recommendation 10: Clarify file hash binding

---

## Document Structure Notes

The fundamental_design_principles.md is well-structured and should maintain its concise nature. Recommendations aim to add clarity without significantly expanding length:

- Current: ~326 lines
- Estimated after all recommendations: ~380-400 lines (still concise)
- Ratio maintained: Still 1/3 the size of detailed v05 document

The additions should be integrated naturally into existing sections rather than creating many new subsections, to maintain the document's accessibility as a "quick start" for technical readers.

---

## Next Steps

Once these recommendations are reviewed and approved, they can be implemented into a new `docs/MPT_fundamental_design_principles_v05.md` file that maintains the concise, accessible style while incorporating the critical v05 updates and improvements identified here.
