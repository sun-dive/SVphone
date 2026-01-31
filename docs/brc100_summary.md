# BRC-100: Wallet-to-Application Interface Summary

Authors: Ty Everett, Tone Engel, Brayden Langley (Project Babbage)

## What is BRC-100?

BRC-100 defines a unified, vendor-neutral wallet-to-application interface for BSV. It standardises how any application communicates with any compliant wallet -- key derivation, transaction creation, encryption, signatures, identity certificates, and blockchain data access -- through a single `WalletInterface`.

The goal: applications never depend on a specific wallet vendor. Any BRC-100-compliant wallet can serve any BRC-100-compliant application.

## Current Implementation Status

- **Old SDK (deprecated):** `@babbage/sdk-ts` in `p2ppsr/babbage-sdk-ts` -- no longer maintained.
- **Current SDK:** `@bsv/sdk` in `bsv-blockchain/ts-sdk` -- BRC-100 is implemented here via `WalletClient` and `WalletInterface`.

The full interface and types are in `@bsv/sdk/src/wallet/Wallet.interfaces.ts`. The client is in `@bsv/sdk/src/wallet/WalletClient.ts`.

---

## Architecture

```
┌──────────────────────────────────────┐
│          Application                 │
│  (uses WalletClient or WalletInterface) │
└────────────────┬─────────────────────┘
                 │
    WalletClient (BRC-100 API surface)
                 │
         ┌───────┴────────┐
         │   Substrate     │  (communication transport)
         └───────┬────────┘
                 │
     ┌───────────┼───────────────────────┐
     │           │           │           │
  window.CWI   XDM     HTTPWalletWire  HTTPWalletJSON
  (in-page)  (iframe)  (Cicada/binary) (JSON REST)
                                         │
                              ReactNativeWebView
```

### WalletClient

`WalletClient` implements `WalletInterface` and proxies all calls through a communication substrate. On construction, you pass a substrate name or a direct `WalletInterface` instance:

```typescript
import { WalletClient } from '@bsv/sdk'

// Auto-detect available wallet
const wallet = new WalletClient('auto')

// Or specify substrate
const wallet2 = new WalletClient('Cicada')       // HTTPWalletWire binary protocol
const wallet3 = new WalletClient('json-api')      // HTTP JSON API
const wallet4 = new WalletClient('window.CWI')    // Browser in-page wallet
const wallet5 = new WalletClient('XDM')            // Cross-document messaging (iframe)
const wallet6 = new WalletClient('react-native')   // React Native WebView
```

Auto mode tries substrates in order: window.CWI, secure-json-api (localhost:2121), json-api, react-native, Cicada, then XDM.

### ProtoWallet

`ProtoWallet` is a lighter building block -- it handles all cryptographic operations (key derivation, signatures, encryption, HMAC) but does NOT create transactions, manage outputs, or interact with the blockchain. Useful for:
- Testing
- Offline cryptographic operations
- Building custom wallet backends

```typescript
import { ProtoWallet, PrivateKey } from '@bsv/sdk'

const pw = new ProtoWallet(PrivateKey.fromRandom())
const { publicKey } = await pw.getPublicKey({ identityKey: true })
const { signature } = await pw.createSignature({
  data: [...Buffer.from('hello')],
  protocolID: [0, 'my protocol'],
  keyID: '1'
})
```

---

## WalletInterface Methods (Complete)

### Transaction Operations

| Method | Purpose |
|--------|---------|
| `createAction(args)` | Build a new transaction with inputs, outputs, labels |
| `signAction(args)` | Sign a previously created (unsigned) transaction |
| `abortAction(args)` | Cancel an incomplete transaction |
| `listActions(args)` | Query transactions by labels |
| `internalizeAction(args)` | Accept an incoming transaction (payment or basket insertion) |
| `listOutputs(args)` | Query spendable outputs by basket and tags |
| `relinquishOutput(args)` | Remove an output from basket tracking without spending |

### Cryptographic Operations

| Method | Purpose |
|--------|---------|
| `getPublicKey(args)` | Get identity key or derived key for protocol/keyID/counterparty |
| `encrypt(args)` | AES-256-GCM encryption with derived symmetric key |
| `decrypt(args)` | Decrypt ciphertext |
| `createHmac(args)` | SHA-256 HMAC with derived key |
| `verifyHmac(args)` | Verify HMAC |
| `createSignature(args)` | ECDSA signature with derived private key |
| `verifySignature(args)` | Verify ECDSA signature |

### Key Linkage

| Method | Purpose |
|--------|---------|
| `revealCounterpartyKeyLinkage(args)` | Reveal shared secret across all interactions with a counterparty |
| `revealSpecificKeyLinkage(args)` | Reveal key offset for a specific protocol/keyID/counterparty |

### Identity Certificates

| Method | Purpose |
|--------|---------|
| `acquireCertificate(args)` | Obtain certificate via direct transfer or issuance protocol |
| `listCertificates(args)` | Query owned certificates by certifier and type |
| `proveCertificate(args)` | Selectively reveal certificate fields to a verifier |
| `relinquishCertificate(args)` | Remove a certificate |
| `discoverByIdentityKey(args)` | Find certificates by public key |
| `discoverByAttributes(args)` | Find certificates by attribute values |

### Authentication & Blockchain

| Method | Purpose |
|--------|---------|
| `isAuthenticated(args)` | Check if user is authenticated |
| `waitForAuthentication(args)` | Block until user authenticates |
| `getHeight(args)` | Current blockchain height |
| `getHeaderForHeight(args)` | 80-byte block header at height |
| `getNetwork(args)` | `'mainnet'` or `'testnet'` |
| `getVersion(args)` | Wallet version string |

---

## Key Concepts

### Security Levels (BRC-43)

```typescript
type SecurityLevel = 0 | 1 | 2
type WalletProtocol = [SecurityLevel, ProtocolString5To400Bytes]
```

| Level | Meaning |
|-------|---------|
| 0 | Silent -- no user interaction required |
| 1 | App-level -- user approves per application |
| 2 | Counterparty-level -- user approves per counterparty per app |

### Key Derivation (BRC-42 BKDS)

Keys are derived from: `(securityLevel, protocolID, keyID, counterparty)`. This produces unique keys for every combination, ensuring:
- Per-protocol key isolation
- Per-counterparty privacy
- No key reuse across contexts

Counterparty can be a public key hex, `'self'` (self-derivation), or `'anyone'` (public derivation using private key `1`).

### Output Baskets (BRC-46)

UTXOs are organised into named baskets for tracking. Each output can have tags for filtering. This is how applications track their token UTXOs without a global indexer.

```typescript
// Store token UTXO in a basket
await wallet.createAction({
  description: 'Create MPT token',
  outputs: [{
    lockingScript: tokenScript,
    satoshis: 1,
    basket: 'mpt-tokens',
    tags: ['nft', 'collection-alpha'],
    outputDescription: 'MPT NFT #0'
  }]
})

// Retrieve token UTXOs
const { outputs } = await wallet.listOutputs({
  basket: 'mpt-tokens',
  tags: ['collection-alpha'],
  include: 'locking scripts'
})
```

### BEEF Format (BRC-62)

Transactions are exchanged in BEEF (Background Evaluated Extended Format) -- a binary format that includes the transaction plus its full SPV ancestry (parent transactions and Merkle proofs). This allows the recipient to verify the transaction without any external lookups.

### Atomic BEEF (BRC-95)

An extension of BEEF for atomic transaction bundles. Used by `createAction` and `signAction` results.

### Internalizing Actions (BRC-29)

When receiving a transaction, `internalizeAction` processes outputs as either:
- **`wallet payment`** -- credits the wallet balance using BRC-29 key derivation
- **`basket insertion`** -- places the output into a named basket for token tracking

---

## Communication Substrates

| Substrate | Class | Use Case |
|-----------|-------|----------|
| `window.CWI` | `WindowCWISubstrate` | Browser extension wallets injecting into page |
| `XDM` | `XDMSubstrate` | Cross-document messaging (wallet in iframe) |
| `Cicada` | `WalletWireTransceiver` + `HTTPWalletWire` | Binary wire protocol over HTTP |
| `json-api` | `HTTPWalletJSON` | JSON REST API (default `http://localhost:3301`) |
| `secure-json-api` | `HTTPWalletJSON` | JSON REST API over HTTPS (`https://localhost:2121`) |
| `react-native` | `ReactNativeWebView` | React Native bridge |

The WalletWire protocol (used by Cicada) is a binary serialisation layer defined in `WalletWire.ts` / `WalletWireCalls.ts` with call codes for each method.

---

## Foundational BRC Dependencies

| BRC | Topic |
|-----|-------|
| BRC-2 | AES-256-GCM encryption/decryption |
| BRC-3 | ECDSA digital signatures (secp256k1) |
| BRC-29 | Payment key derivation for internalizing outputs |
| BRC-42 | BKDS key derivation scheme |
| BRC-43 | Security levels, protocol IDs, key IDs, counterparties |
| BRC-44 | Admin-reserved protocols (wallet-internal) |
| BRC-45 | UTXOs as tokens |
| BRC-46 | Output basket tracking |
| BRC-52 | Identity certificates with selective revelation |
| BRC-56 | HMAC operations |
| BRC-62 | BEEF transaction format |
| BRC-67 | SPV validation rules |
| BRC-69 | Key linkage revelations |
| BRC-72 | Key linkage protection |
| BRC-95 | Atomic BEEF format |
| BRC-97 | Flexible proof-type fields (ZKP support) |
| BRC-98 | Reserved protocol identifiers |
| BRC-99 | Reserved basket identifiers |

---

## Relevance to MPT Project

The MPT project's `WalletProvider` interface (`src/wallet/provider.ts`) is a simpler, SPV-focused abstraction. BRC-100 is much broader. The key overlap and mapping:

| MPT WalletProvider | BRC-100 WalletInterface | Notes |
|--------------------|------------------------|-------|
| `getPublicKey()` | `getPublicKey({ identityKey: true })` | BRC-100 adds derived keys |
| `getUtxos()` | `listOutputs({ basket })` | BRC-100 uses baskets |
| `sign(raw)` | `createAction()` / `signAction()` | BRC-100 manages full TX lifecycle |
| `broadcast(tx)` | Handled by `createAction()` | BRC-100 broadcasts automatically |
| `getBlockHeader(height)` | `getHeaderForHeight({ height })` | Direct equivalent |
| `getMerkleProof(txId)` | Not in BRC-100 | BRC-100 uses BEEF (proofs embedded in TX format) |
| `getRawTransaction(txId)` | `listActions()` with includes | Indirect; BEEF contains full TX chain |

### Key Differences

1. **BEEF vs explicit Merkle proofs**: BRC-100 embeds SPV proofs inside the BEEF transaction format. MPT's proof chain approach stores proofs separately. Both achieve SPV verification but through different structures.

2. **Basket-based UTXO tracking**: BRC-100 organises UTXOs into baskets rather than querying by address. MPT tokens would go into a basket like `'mpt-tokens'`.

3. **Transaction lifecycle**: BRC-100's `createAction` handles input selection, signing, and broadcasting in one call. MPT's approach separates these steps.

4. **No raw UTXO query**: BRC-100 doesn't expose address-based UTXO lookup. Outputs are tracked by basket insertion, not by scanning the chain.

### Integration Path

To make MPT work with a BRC-100 wallet:
- Token UTXOs would be stored in an output basket (e.g., `'mpt-tokens'`)
- Genesis and transfers would use `createAction` with custom locking scripts
- Proof chains could be stored in `customInstructions` on outputs
- Block header verification uses `getHeaderForHeight` directly
- Incoming tokens use `internalizeAction` with `basket insertion` protocol

---

## Source Repositories

| Repository | URL | Status |
|------------|-----|--------|
| BRC Specifications | https://github.com/bitcoin-sv/BRCs | Active |
| BSV TypeScript SDK | https://github.com/bsv-blockchain/ts-sdk | Active |
| Babbage SDK (old) | https://github.com/p2ppsr/babbage-sdk-ts | Deprecated |

Local clones in this repo:
- `code_examples/BRCs/` -- Full BRC specifications
- `code_examples/bsv-sdk/` -- BSV TypeScript SDK with WalletClient implementation
