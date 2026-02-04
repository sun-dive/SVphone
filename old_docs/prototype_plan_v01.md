# MPT Prototype Wallet -- Implementation Plan

BSV testnet, simple web page, P2PKH + OP_RETURN (no sCrypt).

## Token Design

**Genesis TX:**
- Input 0: funding UTXO
- Output 0: P2PKH(owner) 1 sat -- spendable token UTXO
- Output 1: OP_RETURN(`MPT` | version | tokenName | tokenRules | tokenAttributes | ownerPubKey | stateData) 0 sats
- Output 2: P2PKH change

**Transfer TX:**
- Input 0: token UTXO (P2PKH spend by current owner)
- Input 1: funding UTXO
- Output 0: P2PKH(newOwner) 1 sat
- Output 1: OP_RETURN (same immutables, updated ownerPubKey)
- Output 2: P2PKH change

Token ID = SHA-256(genesisTxId || outputIndex LE || [Token Name] || [Token Rules] || [Token Attributes]) -- same as spec.

## Files to Create

All new files go in `prototype/` directory. Existing `src/` is not modified.

### 1. `prototype/src/cryptoCompat.ts`
Browser-compatible reimplementations of `computeTokenId`, `doubleSha256`, `verifyMerkleProof` using `@bsv/sdk` Hash instead of Node `crypto`. Also re-exports the pure interfaces (`ProofChain`, `MerkleProofEntry`, `MerklePathNode`) and the `verifyProofChain`, `createProofChain`, `extendProofChain` functions.

### 2. `prototype/src/opReturnCodec.ts`
- `encodeOpReturn(data)` -- builds OP_FALSE OP_RETURN script with pushdata fields: `MPT` prefix, version byte, tokenName, tokenRules (8 bytes), tokenAttributes, ownerPubKey (33 bytes), stateData.
- `decodeOpReturn(script)` -- parses chunks back into structured data.
- `encodeTokenRules(supply, divisibility, restrictions, version)` -- copied from `src/lib/genesis.ts` body to avoid scrypt-ts import.

### 3. `prototype/src/wocProvider.ts`
`WocProvider` class implementing `WalletProvider` interface for BSV testnet:
- Constructor takes `PrivateKey` (or WIF string)
- `getPublicKey()` -- from local key
- `getUtxos()` -- WhatsOnChain `/address/{addr}/unspent`
- `sign()` -- throws (TX building is done directly in the token builder)
- `broadcast()` -- WhatsOnChain `/tx/raw`
- `getBlockHeader()` -- WhatsOnChain `/block/height/{h}` + `/block/{hash}/header`
- `getMerkleProof()` -- WhatsOnChain `/tx/{txid}/proof/tsc`, mapped to `MerkleProofEntry`
- `getRawTransaction()` -- WhatsOnChain `/tx/{txid}/hex`
- Exposes `getPrivateKey()` and `getAddress()` for direct use by the TX builder

### 4. `prototype/src/p2pkhTokenBuilder.ts`
Core transaction builder using `@bsv/sdk` `Transaction`, `P2PKH`, `SatoshisPerKilobyte`:

**`createGenesis(params)`:**
1. Fetch UTXOs, pick funding UTXO
2. Fetch source TX hex via `getRawTransaction`, parse with `Transaction.fromHex`
3. Build TX: funding input -> P2PKH output (1 sat) + OP_RETURN output (0 sat) + change
4. `await tx.fee()`, `await tx.sign()`
5. Broadcast, compute tokenId, store in TokenManager with empty proof chain
6. Return { txId, tokenId }

**`createTransfer(tokenId, recipientPubKey)`:**
1. Load token from TokenManager
2. Fetch source TXs for token UTXO and funding UTXO
3. Build TX: token input + funding input -> P2PKH(recipient, 1 sat) + OP_RETURN(updated) + change
4. Sign, broadcast
5. Export bundle JSON for recipient, remove token from sender's wallet
6. Return { txId, tokenId, bundle }

**`receiveToken(bundleJson)`:**
1. Parse bundle
2. Verify proof chain (if entries exist) via browser-compatible verify
3. Verify tokenId matches genesis
4. Store in TokenManager

**`pollForProof(tokenId, txId)`:**
Poll WhatsOnChain every 10s for Merkle proof. Once available, update the stored proof chain.

### 5. `prototype/src/app.ts`
Browser entry point:

**LocalStorageBackend** -- implements `StorageBackend` wrapping `localStorage` with `mpt:` prefix.

**Initialization:**
1. Check localStorage for saved WIF. If none, generate `PrivateKey.fromRandom()`, save WIF.
2. Create WocProvider, TokenManager (with LocalStorageBackend), P2pkhTokenBuilder.
3. Display testnet address, balance, link to faucet.
4. Render token list.

**UI handlers:**
- **Mint** -- reads name/attributes inputs, calls `createGenesis`, starts proof polling
- **Transfer** -- reads tokenId + recipient pubkey, calls `createTransfer`, shows bundle JSON
- **Import** -- pastes bundle JSON, calls `receiveToken`
- **Verify** -- selects token, runs proof chain verification, shows result
- **Refresh** -- re-fetches UTXOs and token list

### 6. `prototype/index.html`
Single HTML page with sections: Wallet Info, Mint, My Tokens, Transfer, Import, Verify. Loads `bundle.js`. Minimal inline CSS.

### 7. `prototype/build.mjs`
esbuild script: bundles `src/app.ts` into `bundle.js`, platform=browser, format=iife, sourcemap.

### 8. `prototype/tsconfig.json`
ES2020 target, ESNext modules, DOM lib, strict, no experimentalDecorators.

## Reuse from Existing Code

| Existing file | Usage |
|---|---|
| `src/wallet/provider.ts` | Import `WalletProvider`, `Utxo`, `BlockHeader` interfaces |
| `src/wallet/tokenManager.ts` | Import `TokenManager`, `OwnedToken`, `TokenBundle` directly |
| `src/wallet/proofStore.ts` | Import `StorageBackend`, `ProofStore`, `MemoryStorage` |
| `src/wallet/helpers.ts` | Import `serialiseBundle`, `parseBundle`, `tokenSummary`, `verifyOwnership` |
| `src/lib/proofChain.ts` | Type imports only (`ProofChain`, `MerkleProofEntry`); logic reimplemented in cryptoCompat.ts |

Files NOT imported (scrypt-ts dependent): `genesis.ts`, `transfer.ts`, `txBuilder.ts`, `mpt.ts`.

## Dependencies to Add

```
npm install --save-dev esbuild
```

`@bsv/sdk` is already in package.json. No other new dependencies needed.

## Build & Run

```bash
npm install
cd prototype && node build.mjs
npx serve prototype/    # or any static file server
```

Open browser, copy testnet address, fund from faucet, mint a token, wait for confirmation, transfer.

## Implementation Order

1. Create directory structure and config files (tsconfig, build.mjs)
2. `cryptoCompat.ts` -- browser-safe crypto
3. `opReturnCodec.ts` -- OP_RETURN encoding
4. `wocProvider.ts` -- WhatsOnChain provider
5. `p2pkhTokenBuilder.ts` -- real TX building
6. `app.ts` -- UI wiring with LocalStorageBackend
7. `index.html` -- the page
8. Build and test

## Verification

1. `node build.mjs` succeeds without errors
2. Open `index.html` in browser, address displays
3. Fund from testnet faucet, balance updates on refresh
4. Mint a token -- TX broadcasts, txid and tokenId display
5. After ~10 min, proof polling succeeds, proof chain stored
6. Transfer token to another pubkey -- TX broadcasts, bundle JSON shown
7. Open second browser/incognito, import bundle -- token appears in list
8. Verify token -- proof chain validates against block headers
