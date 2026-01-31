# BSV Blockchain Connection Reference

How to connect a JavaScript/TypeScript application to the BSV blockchain for SPV wallet operations.

---

## @bsv/sdk (v1.x)

The project already depends on `@bsv/sdk@^1.0.0`. The SDK handles key management, transaction building/signing, and provides interfaces for broadcasting and chain verification. It does **not** connect directly to BSV nodes -- it relies on API services.

### Key Generation

```typescript
import { PrivateKey, P2PKH } from '@bsv/sdk'

const privKey = PrivateKey.fromRandom()
const privKey2 = PrivateKey.fromWif('L1example...')
const pubKey = privKey.toPublicKey()
const address = pubKey.toAddress()
```

### Transaction Building

```typescript
import { Transaction, P2PKH, ARC } from '@bsv/sdk'

const sourceTransaction = Transaction.fromHex('0100000001...')

const tx = new Transaction()
tx.addInput({
  sourceTransaction,       // full parent TX required for BEEF/SPV
  sourceOutputIndex: 0,
  unlockingScriptTemplate: new P2PKH().unlock(privKey)
})
tx.addOutput({
  lockingScript: new P2PKH().lock(recipientAddress),
  satoshis: 1000
})
tx.addOutput({
  lockingScript: new P2PKH().lock(changeAddress),
  change: true
})
await tx.fee()
await tx.sign()
```

The SDK prefers `sourceTransaction` (full parent Transaction object) over just `sourceTXID` because BEEF serialisation requires the full parent chain for SPV verification.

### Broadcasting via ARC

```typescript
import { ARC } from '@bsv/sdk'

const arc = new ARC('https://arc.gorillapool.io')
await tx.broadcast(arc)
```

### Chain Tracking (Merkle Root Verification)

```typescript
import { WhatsOnChain } from '@bsv/sdk'

const chainTracker = new WhatsOnChain('main')  // or 'test'
const isValid = await incomingTx.verify(chainTracker)
```

---

## API Services

### WhatsOnChain

**Base URL:** `https://api.whatsonchain.com/v1/bsv/{network}/` where `{network}` is `main` or `test`.

| Tier | Rate Limit | Cost |
|------|-----------|------|
| Free (no key) | 3 req/sec | Free |
| Free account | 3 req/sec | Free (API key in `Authorization` header) |
| Paid | 10-40 req/sec | Subscription via Teranode Group Platform |

#### Endpoints for SPV Wallet

**UTXOs by address:**
```
GET /address/{address}/unspent
Response: [{ tx_hash, tx_pos, value, height }]
```

**Bulk UTXOs (up to 20 addresses):**
```
POST /addresses/unspent
Body: { "addresses": ["addr1", "addr2"] }
```

**Broadcast transaction:**
```
POST /tx/raw
Body: { "txhex": "0100000001..." }
Returns: txid
```

**Raw transaction hex:**
```
GET /tx/{txid}/hex
```

**Merkle proof (TSC format):**
```
GET /tx/{txid}/proof/tsc
```
Returns TSC-compliant Merkle proof for confirmed transactions. Returns null for unconfirmed.

**Block header by height:**
```
GET /block/height/{height}/header
```

**Block header by hash:**
```
GET /block/{blockhash}/header
Response: { hash, height, merkleroot, time, previousblockhash, ... }
```

---

### ARC Transaction Processor

ARC is the standard transaction broadcasting protocol for BSV going forward (replaces mAPI, required for Teranode compatibility).

| Provider | URL | Auth |
|----------|-----|------|
| GorillaPool | `https://arc.gorillapool.io` | Optional |
| TAAL | `https://api.taal.com/arc` | API key from console.taal.com |

#### Key Endpoints

**Submit transaction:**
```
POST /v1/tx
Content-Type: application/octet-stream
Authorization: Bearer <api_key>  (TAAL)
```

**Query transaction status:**
```
GET /v1/tx/{txid}
```

**Get fee policy:**
```
GET /v1/policy
```

#### Transaction Statuses

| Status | Meaning |
|--------|---------|
| QUEUED | Queued for processing |
| SENT_TO_NETWORK | Sent to at least 1 node |
| SEEN_ON_NETWORK | In mempool |
| MINED | Included in a block |

ARC supports optional callback URLs (`X-CallbackUrl` header) for async status notifications.

---

### GorillaPool / JungleBus

**GorillaPool** operates BSV mining infrastructure, ARC, and JungleBus.

**JungleBus** provides real-time filtered transaction streaming without a full node:
```
npm install @gorillapool/js-junglebus
```
Useful for monitoring incoming transactions to the wallet in real time.

**1Sat Ordinals API** (GorillaPool) provides UTXO and inscription endpoints:
```
GET https://ordinals.gorillapool.io/api/utxos/address/{address}
```

---

## SPV Operations Summary

| Operation | Recommended Service | Endpoint / SDK Method |
|-----------|--------------------|-----------------------|
| Broadcast TX | ARC (GorillaPool) | `new ARC('https://arc.gorillapool.io')` |
| Fetch UTXOs | WhatsOnChain | `GET /address/{addr}/unspent` |
| Get Merkle proof | WhatsOnChain | `GET /tx/{txid}/proof/tsc` |
| Get block header | WhatsOnChain | `GET /block/height/{h}/header` |
| Verify Merkle root | @bsv/sdk | `new WhatsOnChain('main')` as ChainTracker |
| Get raw transaction | WhatsOnChain | `GET /tx/{txid}/hex` |
| Real-time monitoring | JungleBus | `@gorillapool/js-junglebus` |

---

## Testnet

- **WhatsOnChain testnet API:** same endpoints with `test` instead of `main`
- **Testnet explorer:** https://test.whatsonchain.com/
- **Faucet:** https://witnessonchain.com/faucet/tbsv
- **SDK:** `new WhatsOnChain('test')` for chain tracking

---

## Self-Hosted Option: Block Headers Service (Pulse)

For true SPV independence without trusting third-party header data:

**GitHub:** https://github.com/bsv-blockchain/block-headers-service

A Go service that syncs only block headers from the P2P network and exposes a REST API for Merkle root validation. Lightweight alternative to running a full node.

---

## Mapping to WalletProvider Interface

The project's `WalletProvider` interface in `src/wallet/provider.ts` maps to services as follows:

| WalletProvider Method | Implementation |
|-----------------------|----------------|
| `getPublicKey()` | Local key store (`PrivateKey.fromWif().toPublicKey()`) |
| `getUtxos()` | WhatsOnChain `/address/{addr}/unspent` |
| `sign(raw)` | `@bsv/sdk` `PrivateKey` + `Transaction.sign()` |
| `broadcast(tx)` | ARC via `@bsv/sdk` `new ARC(url)` |
| `getBlockHeader(height)` | WhatsOnChain `/block/height/{h}/header` |
| `getMerkleProof(txId)` | WhatsOnChain `/tx/{txid}/proof/tsc` |
| `getRawTransaction(txId)` | WhatsOnChain `/tx/{txid}/hex` |
