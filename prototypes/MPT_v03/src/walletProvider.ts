/**
 * WhatsOnChain-based wallet provider for BSV mainnet.
 *
 * This is the WALLET layer -- responsible for all network operations:
 *   - UTXO lookup (funding transactions)
 *   - Broadcasting signed transactions
 *   - Fetching raw transactions (for building inputs)
 *   - Fetching block headers (for SPV verification)
 *   - Fetching Merkle proofs (for proof chain construction)
 *   - Address history (for incoming token detection)
 *
 * The token protocol (tokenProtocol.ts) has NO dependency on this module.
 * Verification can be done offline with pre-fetched headers.
 */
import { PrivateKey, Transaction } from '@bsv/sdk'
import type { MerkleProofEntry, MerklePathNode, BlockHeader as SpvBlockHeader } from './tokenProtocol'

// Use local proxy on localhost to avoid CORS issues
const WOC_BASE = (typeof location !== 'undefined' && location.hostname === 'localhost')
  ? '/woc/v1/bsv/main'
  : 'https://api.whatsonchain.com/v1/bsv/main'

// ─── Types ──────────────────────────────────────────────────────────

export interface Utxo {
  txId: string
  outputIndex: number
  satoshis: number
  script: string
}

export interface WalletBlockHeader extends SpvBlockHeader {
  hash: string
  timestamp: number
  prevHash: string
}

// ─── Rate Limiter ───────────────────────────────────────────────────

const MIN_REQUEST_DELAY = 200
let lastRequestTime = 0

async function throttledFetch(url: string, init?: RequestInit): Promise<Response> {
  const now = Date.now()
  const elapsed = now - lastRequestTime
  if (elapsed < MIN_REQUEST_DELAY) {
    await new Promise(r => setTimeout(r, MIN_REQUEST_DELAY - elapsed))
  }
  lastRequestTime = Date.now()
  return fetch(url, init)
}

// ─── Wallet Provider ────────────────────────────────────────────────

export class WalletProvider {
  private key: PrivateKey
  private txCache = new Map<string, string>()

  constructor(key: PrivateKey) {
    this.key = key
  }

  getPrivateKey(): PrivateKey {
    return this.key
  }

  getPublicKeyHex(): string {
    return this.key.toPublicKey().toString()
  }

  getAddress(): string {
    return this.key.toAddress()
  }

  // ── Wallet Operations (UTXO model) ─────────────────────────────

  async getUtxos(): Promise<Utxo[]> {
    const address = this.getAddress()
    const resp = await throttledFetch(`${WOC_BASE}/address/${address}/unspent`)
    if (!resp.ok) throw new Error(`WoC UTXO fetch failed: ${resp.status}`)
    const data = await resp.json()
    if (!Array.isArray(data)) return []
    return data.map((u: any) => ({
      txId: u.tx_hash as string,
      outputIndex: u.tx_pos as number,
      satoshis: u.value as number,
      script: '',
    }))
  }

  async getBalance(): Promise<number> {
    const utxos = await this.getUtxos()
    return utxos.reduce((sum, u) => sum + u.satoshis, 0)
  }

  // ── Broadcasting ──────────────────────────────────────────────

  async broadcast(rawHex: string): Promise<string> {
    const resp = await throttledFetch(`${WOC_BASE}/tx/raw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txhex: rawHex }),
    })
    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`Broadcast failed (${resp.status}): ${text}`)
    }
    const txId = await resp.text()
    return txId.replace(/"/g, '')
  }

  // ── Raw Transactions ──────────────────────────────────────────

  async getRawTransaction(txId: string): Promise<string> {
    const cached = this.txCache.get(txId)
    if (cached) return cached
    const resp = await throttledFetch(`${WOC_BASE}/tx/${txId}/hex`)
    if (!resp.ok) throw new Error(`WoC raw TX fetch failed: ${resp.status}`)
    const hex = await resp.text()
    this.txCache.set(txId, hex)
    return hex
  }

  async getSourceTransaction(txId: string): Promise<Transaction> {
    const hex = await this.getRawTransaction(txId)
    return Transaction.fromHex(hex)
  }

  // ── Block Headers (feeds into SPV verification) ───────────────

  async getBlockHeader(height: number): Promise<WalletBlockHeader> {
    const hashResp = await throttledFetch(`${WOC_BASE}/block/height/${height}`)
    if (!hashResp.ok) throw new Error(`WoC block height fetch failed: ${hashResp.status}`)
    const blockHash = (await hashResp.text()).replace(/"/g, '')

    const headerResp = await throttledFetch(`${WOC_BASE}/block/${blockHash}/header`)
    if (!headerResp.ok) throw new Error(`WoC block header fetch failed: ${headerResp.status}`)
    const hdr = await headerResp.json()

    return {
      height,
      merkleRoot: hdr.merkleroot,
      hash: hdr.hash,
      timestamp: hdr.time,
      prevHash: hdr.previousblockhash,
    }
  }

  // ── Address History ───────────────────────────────────────────

  async getAddressHistory(): Promise<{ txId: string; blockHeight: number }[]> {
    const address = this.getAddress()
    const resp = await throttledFetch(`${WOC_BASE}/address/${address}/history`)
    if (!resp.ok) throw new Error(`WoC history fetch failed: ${resp.status}`)
    const data = await resp.json()
    if (!Array.isArray(data)) return []
    return data.map((entry: any) => ({
      txId: entry.tx_hash as string,
      blockHeight: (entry.height ?? 0) as number,
    }))
  }

  // ── Merkle Proofs (feeds into proof chain construction) ───────

  async getMerkleProof(txId: string): Promise<MerkleProofEntry | null> {
    const resp = await throttledFetch(`${WOC_BASE}/tx/${txId}/proof/tsc`)
    if (!resp.ok) {
      console.debug(`getMerkleProof: WoC returned ${resp.status} for ${txId.slice(0, 12)}...`)
      return null
    }

    const raw = await resp.json()
    console.debug('getMerkleProof: raw response:', JSON.stringify(raw).slice(0, 200))
    const data = Array.isArray(raw) ? raw[0] : raw
    if (!data || !data.target) {
      console.debug('getMerkleProof: no target in proof data:', data)
      return null
    }

    const nodes: string[] = data.nodes ?? []
    const index: number = data.index ?? 0
    const path: MerklePathNode[] = []

    let idx = index
    for (const node of nodes) {
      if (node === '*') {
        idx = idx >> 1
        continue
      }
      const position: 'L' | 'R' = (idx % 2 === 0) ? 'R' : 'L'
      path.push({ hash: node, position })
      idx = idx >> 1
    }

    const blockHash = data.target
    const headerResp = await throttledFetch(`${WOC_BASE}/block/${blockHash}/header`)
    if (!headerResp.ok) return null
    const header = await headerResp.json()

    return {
      txId,
      blockHeight: header.height,
      merkleRoot: header.merkleroot,
      path,
    }
  }
}
