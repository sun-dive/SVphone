# MPT Project Initiation

You are being onboarded to the Merkle Proof Token (MPT) project. Before making any code changes, you must read and understand the project documentation and codebase.

## Step 1: Read the onboarding guide

Read `docs/bootcamp/initiation.md` for the recommended reading order and key concepts.

## Step 2: Read core documentation

Read these files to understand the protocol design:
1. `docs/MPT_fundamental_design_principles.md` — Token lifecycle, SPV verification, data fields, immutable vs mutable fields
2. `docs/MPT_v04_01_structure_and_function.md` — Detailed structure and function documentation

## Step 3: Read the protocol layer code

These files have ZERO network dependencies and form the cryptographic core:
3. `prototype_v05/src/tokenProtocol.ts` — Token ID computation, Merkle proof verification, proof chain validation
4. `prototype_v05/src/opReturnCodec.ts` — OP_RETURN encoding/decoding, chunk structure, immutable byte extraction

## Step 4: Read the wallet layer code

These files require network access via WalletProvider:
5. `prototype_v05/src/tokenStore.ts` — Token persistence, OwnedToken interface, proof chain storage
6. `prototype_v05/src/walletProvider.ts` — Blockchain API abstraction (WhatsOnChain), UTXO fetching, Merkle proofs, block headers
7. `prototype_v05/src/tokenBuilder.ts` — Token operations: mint (createGenesis), transfer, verify, incoming token detection

## Step 5: Read the application layer

8. `prototype_v05/src/app.ts` — UI wiring, event handlers
9. `prototype_v05/index.html` — UI structure

## After Reading

Once you have read and understood the above files, confirm your understanding by summarizing:
1. How Token ID is computed
2. The difference between immutable and mutable fields
3. Why only the genesis TX requires block header verification
4. The architecture separation between tokenProtocol.ts and tokenBuilder.ts

Then ask the user what task they would like you to work on.
