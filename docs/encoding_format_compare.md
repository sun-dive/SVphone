# Encoding Format Comparison

## Raw Pushdata (MPT)

Each field is a separate pushdata chunk in the OP_RETURN script.

**Advantages:**
- Trivial to parse -- just split the script into pushdata chunks, no deserializer needed
- Any Bitcoin library can decode it (standard script parsing)
- Human-readable when fields are UTF-8 (tokenName, etc.)
- No schema dependency -- parser doesn't need a .proto file, CBOR lib, or class definitions
- Minimal overhead -- no framing bytes, type tags, or field numbers beyond the pushdata length prefix

**Disadvantages:**
- Positional -- fields are identified by index, not by name. Adding/removing fields requires version bumps
- No built-in typing -- everything is raw bytes, the parser must know the schema externally
- No nested structures -- flat only, unless you embed a sub-encoding (like MPT does with proofChainBinary)
- No compression or packing -- repeated or sparse data wastes space

---

## Content Blob (1Sat Ordinals)

A content-type header followed by a raw data payload (image, text, JSON, etc.).

**Advantages:**
- Maximum flexibility -- any MIME type, any format
- Simple for inscriptions where the payload is opaque content (images, HTML, etc.)
- Familiar web semantics (content-type negotiation)

**Disadvantages:**
- No structure enforcement -- the blob is opaque to parsers unless they understand the specific content-type
- Parsing depends entirely on the content-type, so every consumer needs multiple decoders
- No field-level access -- you must decode the entire blob to extract any single value
- Versioning and schema evolution are ad-hoc (up to the content format)

---

## CBOR (RUN Protocol)

Concise Binary Object Representation -- a binary JSON-like format (RFC 8949).

**Advantages:**
- Self-describing -- each value carries its own type tag, so parsers don't need an external schema
- Compact -- significantly smaller than JSON for structured data
- Supports nested objects, arrays, binary blobs, and typed values natively
- Standardized (IETF RFC), with libraries in every language
- Schema-optional -- can be parsed without knowing the structure in advance

**Disadvantages:**
- Requires a CBOR library -- can't be decoded with just Bitcoin script parsing
- Self-describing tags add overhead compared to a known-schema format like Protobuf
- Debugging is harder -- not human-readable, needs a tool to inspect
- No schema enforcement at the encoding level -- malformed payloads are syntactically valid CBOR

---

## Script Opcodes (STAS)

Token logic and data encoded directly in Bitcoin Script locking/unlocking scripts.

**Advantages:**
- Enforced at the consensus layer -- miners validate the rules during script execution
- No separate parsing step -- the data IS the script
- Atomic enforcement -- invalid token operations are literally unspendable
- Can encode complex spending conditions (multisig, timelocks, hashlocks) natively

**Disadvantages:**
- Script size limits and opcode restrictions constrain what can be encoded
- Extremely hard to debug -- requires a Script interpreter to understand
- Not portable -- tightly coupled to Bitcoin's scripting engine
- Requires specialized wallets that understand the custom locking scripts
- Upgrading the format means changing spending conditions, which is risky
- Not human-readable at any level

---

## Protocol Buffers (Tokenized)

Google's binary serialization format with a required .proto schema definition.

**Advantages:**
- Very compact -- field numbers + wire types, no field names on the wire
- Strong schema with explicit field numbers -- excellent backwards/forwards compatibility
- Fields can be added without breaking old parsers (unknown fields are skipped)
- Generated code in every major language -- type-safe, fast
- Well-suited for complex message types with many optional fields

**Disadvantages:**
- Schema required -- both encoder and decoder must have the .proto file to make sense of the data
- Completely opaque without the schema -- raw bytes are uninterpretable
- Heavier dependency -- needs the protobuf compiler and runtime library
- Overkill for simple flat structures (the schema machinery adds complexity for minimal benefit)
- Not self-describing -- unlike CBOR, you can't inspect an unknown Protobuf message

---

## Summary

| Criterion | Raw Pushdata | Content Blob | CBOR | Script Opcodes | Protobuf |
|---|---|---|---|---|---|
| Parse complexity | Trivial | Varies | Library needed | Script interpreter | Library + schema |
| Schema needed | No (positional) | No (opaque) | No (self-describing) | Implicit in script | **Yes** |
| Compactness | Good | Poor-Good | Very good | Good | Best |
| Human readability | Partial | Depends | No | No | No |
| Nested structures | No | Depends | Yes | Limited | Yes |
| Schema evolution | Version bump | Ad-hoc | Flexible | Difficult | Excellent |
| External dependencies | None | Content decoders | CBOR library | Script engine | Protobuf runtime |
| Consensus enforcement | No | No | No | **Yes** | No |

For MPT's use case -- a flat set of known fields, parsed by any Bitcoin-capable client, with no external dependencies -- raw pushdata is the right fit. The protocol is simple enough that positional encoding isn't a burden, and the zero-dependency parsing aligns with the SPV-only philosophy.

---

## Large stateData and OP_RETURN Rewrite Cost

BSV removed the OP_RETURN size cap entirely with the Genesis upgrade (February 2020). The practical limit is the maximum transaction size, which is a miner policy setting -- currently up to 4GB at the consensus level.

However, the current MPT design rewrites the full OP_RETURN on every transfer TX, including `stateData`. The proof chain does **not** contain `stateData` -- each entry is just txId (32B), blockHeight (4B), merkleRoot (32B), and Merkle path nodes (~32B each). So large stateData does not bloat the proof chain.

The real cost is that every transfer repeats the full OP_RETURN. With 1MB stateData and 100 transfers, that's ~100MB of cumulative on-chain data for the OP_RETURN outputs alone. This is valid on BSV but gets expensive even at low fee rates.

### Mitigation Strategies for Large stateData

1. **Hash-only on-chain**: Store `SHA-256(stateData)` in the OP_RETURN, keep the actual data off-chain (passed in the bundle). The hash is 32 bytes regardless of data size. Verification checks the hash matches.

2. **Store-once, reference-by-txId**: Write the large data in the genesis TX only. Subsequent transfers reference it implicitly via `genesisTxId` -- the recipient can fetch the genesis TX to recover the original data.

3. **Delta encoding**: Only include changed fields in each transfer's OP_RETURN. Requires the recipient to replay from genesis to reconstruct current state.

Option 1 is the cleanest fit for MPT's philosophy -- the hash travels on-chain (small, verifiable), the data travels in the bundle or can be fetched from the genesis TX.

---

## tokenRules Enforcement Model

### Current State (v03)

`tokenRules` is an 8-byte packed field (4 x uint16 LE): supply, divisibility, restrictions (bitfield), and version. It is encoded at mint, stored on-chain in the OP_RETURN, and copied unchanged on every transfer. However, `decodeTokenRules()` is never called anywhere in v03 -- the rules are pure metadata with zero enforcement.

### Application-Level vs Consensus-Level Enforcement

MPT's OP_RETURN is unspendable by design -- miners don't execute any logic on it. This means rules cannot be enforced at the consensus layer (unlike STAS, where invalid token operations are literally unspendable). Any rules in `tokenRules` are only enforceable by the wallets that read them.

This is not a weakness -- it's a design choice. MPT doesn't **prevent** bad transactions (you can't without script enforcement), but it **detects** them during verification. A transaction that violated the token's rules would be rejected by the recipient's wallet.

### Potential Rule Types

The `tokenRules` restrictions bitfield could include rules governing modification of on-chain fields between consecutive transfers:

- Bit 0: `stateData` is immutable after genesis
- Bit 1: `tokenAttributes` is immutable after genesis
- Bit 2: transfers restricted (only genesis owner can hold)
- etc.

### Enforcement as Recipient Validation

The enforcement model is a **validation gate at the recipient**, not a retroactive invalidation of the token:

1. Recipient wallet receives a transfer
2. Walks the proof chain, comparing each consecutive pair of OP_RETURN states
3. If the latest TX violates a rule (e.g. changed `stateData` when rules say immutable), the recipient **rejects that transfer**
4. The sender's wallet still considers itself the owner -- the **token** is not invalidated, only the **transaction** is rejected
5. Sender can construct a new, rule-compliant transfer and try again

This is analogous to how a malformed Bitcoin transaction doesn't destroy the UTXOs it tried to spend -- they're still there, spendable by a valid transaction. The proof chain up to the last rule-compliant TX remains perfectly valid.

### Only Previous TX Needs Checking

Each entry in the proof chain only needs to be compared against its immediate predecessor. If any ancestor broke the rules, the chain walk would catch the violation at that specific step. There is no need to do any broader inspection -- the linear chain walk already compares consecutive pairs.

### What Would Need to Change for Implementation

1. Define the restriction bitfield semantics formally
2. Extend `verifyProofChain` to decode OP_RETURN data from each TX in the chain
3. Compare consecutive entries to check rule compliance
4. Return a rejection (not token invalidation) when a rule is violated
