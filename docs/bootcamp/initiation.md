# MPT Project Onboarding

Before making any code changes, read and understand these files in order:

## 1. Core Documentation (read first)

Read these to understand the protocol design and architecture:

1. `docs/MPT_fundamental_design_principles.md` — Token lifecycle, SPV verification, data fields, immutable vs mutable fields
2. `docs/MPT_v04_01_structure_and_function.md` — Detailed structure and function documentation (note: covers v05 despite filename)

## 2. Protocol Layer (pure SPV, no network dependencies)

3. `prototype_v05/src/tokenProtocol.ts` — Token ID computation, Merkle proof verification, proof chain validation. This is the cryptographic core.
4. `prototype_v05/src/opReturnCodec.ts` — OP_RETURN encoding/decoding, chunk structure, immutable byte extraction

## 3. Wallet Layer (network-dependent)

5. `prototype_v05/src/tokenStore.ts` — Token persistence, OwnedToken interface, proof chain storage
6. `prototype_v05/src/walletProvider.ts` — Blockchain API abstraction (WhatsOnChain), UTXO fetching, Merkle proofs, block headers
7. `prototype_v05/src/tokenBuilder.ts` — Token operations: mint (createGenesis), transfer, verify, incoming token detection, SPV verification gate

## 4. Application Layer

8. `prototype_v05/src/app.ts` — UI wiring, event handlers
9. `prototype_v05/index.html` — UI structure

## 5. Supplementary (if relevant to task)

- `docs/consensus_level_scripts_research.md` — Background on Token Script consensus enforcement patterns

## Key Concepts to Understand

- **Token ID**: SHA-256(genesisTxId || outputIndex_LE || tokenName || tokenScript || tokenRules || tokenAttributes)
- **SPV Verification**: Only the genesis TX requires block header confirmation; transfer TXs are validated by miners implicitly
- **Proof Chain**: Array of Merkle proof entries, newest-first, oldest entry = genesis TX
- **Immutable Fields**: tokenName, tokenScript, tokenRules, tokenAttributes — bound to Token ID
- **Mutable Fields**: stateData — can change on transfer

## Architecture Separation

- `tokenProtocol.ts` = ZERO network dependencies, runs anywhere (browser, Node, offline)
- `tokenBuilder.ts` = Wallet layer, requires network access via WalletProvider
