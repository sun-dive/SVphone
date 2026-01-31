/**
 * P2PKH + OP_RETURN token builder for the MPT prototype.
 *
 * Builds real BSV transactions using @bsv/sdk.
 * Token ownership is via P2PKH; metadata is in OP_RETURN.
 */
import { Transaction, P2PKH, PublicKey, SatoshisPerKilobyte } from '@bsv/sdk'
import { WocProvider, Utxo } from './wocProvider'
import { encodeOpReturn, TokenOpReturnData, encodeTokenRules } from './opReturnCodec'
import {
  computeTokenId,
  createProofChain,
  extendProofChain,
  MerkleProofEntry,
  ProofChain,
} from './cryptoCompat'

// ─── Types ──────────────────────────────────────────────────────────

export interface OwnedToken {
  tokenId: string
  genesisTxId: string
  genesisOutputIndex: number
  currentTxId: string
  currentOutputIndex: number
  tokenName: string
  tokenRules: string
  tokenAttributes: string
  ownerPubKey: string
  stateData: string
  satoshis: number
}

export interface TokenBundle {
  token: OwnedToken
  proofChain: ProofChain
}

export interface GenesisParams {
  tokenName: string
  attributes?: string // hex, optional
}

export interface GenesisResult {
  txId: string
  tokenId: string
}

export interface TransferResult {
  txId: string
  tokenId: string
  bundleJson: string
}

// ─── Storage ────────────────────────────────────────────────────────

export interface StorageBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export class LocalStorageBackend implements StorageBackend {
  private prefix: string
  constructor(prefix = 'mpt:') { this.prefix = prefix }
  async get(key: string) { return localStorage.getItem(this.prefix + key) }
  async set(key: string, value: string) { localStorage.setItem(this.prefix + key, value) }
  async delete(key: string) { localStorage.removeItem(this.prefix + key) }
  async keys() {
    return Object.keys(localStorage)
      .filter(k => k.startsWith(this.prefix))
      .map(k => k.slice(this.prefix.length))
  }
}

// ─── Simple Token Store ─────────────────────────────────────────────

const TOKEN_KEY = 'token:'
const PROOF_KEY = 'proof:'

export class TokenStore {
  constructor(private storage: StorageBackend) {}

  async addToken(token: OwnedToken, proofChain: ProofChain): Promise<void> {
    await this.storage.set(TOKEN_KEY + token.tokenId, JSON.stringify(token))
    await this.storage.set(PROOF_KEY + token.tokenId, JSON.stringify(proofChain))
  }

  async getToken(tokenId: string): Promise<OwnedToken | null> {
    const data = await this.storage.get(TOKEN_KEY + tokenId)
    return data ? JSON.parse(data) : null
  }

  async getProofChain(tokenId: string): Promise<ProofChain | null> {
    const data = await this.storage.get(PROOF_KEY + tokenId)
    return data ? JSON.parse(data) : null
  }

  async removeToken(tokenId: string): Promise<void> {
    await this.storage.delete(TOKEN_KEY + tokenId)
    await this.storage.delete(PROOF_KEY + tokenId)
  }

  async listTokens(): Promise<OwnedToken[]> {
    const allKeys = await this.storage.keys()
    const tokens: OwnedToken[] = []
    for (const key of allKeys) {
      if (key.startsWith(TOKEN_KEY)) {
        const data = await this.storage.get(key)
        if (data) tokens.push(JSON.parse(data))
      }
    }
    return tokens
  }
}

// ─── Token Builder ──────────────────────────────────────────────────

const TOKEN_SATS = 1

export class P2pkhTokenBuilder {
  constructor(
    private provider: WocProvider,
    private store: TokenStore
  ) {}

  /**
   * Create a genesis transaction minting a single NFT.
   *
   * TX structure:
   *   Input 0:  funding UTXO
   *   Output 0: P2PKH(owner) 1 sat     -- the token UTXO
   *   Output 1: OP_RETURN(metadata) 0 sat
   *   Output 2: P2PKH(change)
   */
  async createGenesis(params: GenesisParams): Promise<GenesisResult> {
    const key = this.provider.getPrivateKey()
    const address = this.provider.getAddress()
    const pubKeyHex = this.provider.getPublicKeyHex()

    // 1. Find a funding UTXO
    const utxos = await this.provider.getUtxos()
    if (utxos.length === 0) {
      throw new Error('No UTXOs. Fund your testnet address first.')
    }
    const funding = pickLargestUtxo(utxos)

    // 2. Fetch the full source transaction (required by @bsv/sdk for signing)
    const sourceTx = await this.provider.getSourceTransaction(funding.txId)

    // 3. Build the genesis transaction
    const tokenRulesHex = encodeTokenRules(1, 0, 0, 1) // supply=1, NFT, unrestricted, v1
    const attrsHex = params.attributes ?? '00'

    const tx = new Transaction()

    // Input: funding
    tx.addInput({
      sourceTransaction: sourceTx,
      sourceOutputIndex: funding.outputIndex,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })

    // Output 0: token P2PKH (1 sat)
    tx.addOutput({
      lockingScript: new P2PKH().lock(address),
      satoshis: TOKEN_SATS,
    })

    // Output 1: OP_RETURN with token metadata (0 sats)
    const opReturnData: TokenOpReturnData = {
      tokenName: params.tokenName,
      tokenRules: tokenRulesHex,
      tokenAttributes: attrsHex,
      ownerPubKey: pubKeyHex,
      stateData: '',
    }
    tx.addOutput({
      lockingScript: encodeOpReturn(opReturnData),
      satoshis: 0,
    })

    // Output 2: change
    tx.addOutput({
      lockingScript: new P2PKH().lock(address),
      change: true,
    })

    // 4. Fee calculation and signing
    await tx.fee(new SatoshisPerKilobyte(1))
    await tx.sign()

    // 5. Broadcast
    const rawHex = tx.toHex()
    const txId = tx.id('hex') as string

    await this.provider.broadcast(rawHex)

    // 6. Compute Token ID and store
    const tokenId = computeTokenId(txId, 0)

    const ownedToken: OwnedToken = {
      tokenId,
      genesisTxId: txId,
      genesisOutputIndex: 0,
      currentTxId: txId,
      currentOutputIndex: 0,
      tokenName: params.tokenName,
      tokenRules: tokenRulesHex,
      tokenAttributes: attrsHex,
      ownerPubKey: pubKeyHex,
      stateData: '',
      satoshis: TOKEN_SATS,
    }

    // Store with empty proof chain (populated after mining)
    const emptyChain: ProofChain = { genesisTxId: txId, entries: [] }
    await this.store.addToken(ownedToken, emptyChain)

    return { txId, tokenId }
  }

  /**
   * Transfer a token to a new owner.
   *
   * TX structure:
   *   Input 0:  token UTXO (P2PKH spend)
   *   Input 1:  funding UTXO
   *   Output 0: P2PKH(newOwner) 1 sat
   *   Output 1: OP_RETURN(updated metadata) 0 sat
   *   Output 2: P2PKH(change to sender)
   */
  async createTransfer(tokenId: string, recipientPubKeyHex: string): Promise<TransferResult> {
    const key = this.provider.getPrivateKey()
    const myAddress = this.provider.getAddress()

    // 1. Load token
    const token = await this.store.getToken(tokenId)
    if (!token) throw new Error(`Token not found: ${tokenId}`)

    const proofChain = await this.store.getProofChain(tokenId)

    // 2. Fetch source transactions
    const tokenSourceTx = await this.provider.getSourceTransaction(token.currentTxId)

    const utxos = await this.provider.getUtxos()
    // Filter out the token UTXO from funding candidates
    const fundingCandidates = utxos.filter(
      u => !(u.txId === token.currentTxId && u.outputIndex === token.currentOutputIndex)
    )
    if (fundingCandidates.length === 0) {
      throw new Error('No funding UTXOs available (separate from token UTXO)')
    }
    const funding = pickLargestUtxo(fundingCandidates)
    const fundingSourceTx = await this.provider.getSourceTransaction(funding.txId)

    // 3. Derive recipient address
    const recipientPubKey = PublicKey.fromString(recipientPubKeyHex)
    const recipientAddress = recipientPubKey.toAddress('testnet')

    // 4. Build transaction
    const tx = new Transaction()

    // Input 0: token UTXO
    tx.addInput({
      sourceTransaction: tokenSourceTx,
      sourceOutputIndex: token.currentOutputIndex,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })

    // Input 1: funding UTXO
    tx.addInput({
      sourceTransaction: fundingSourceTx,
      sourceOutputIndex: funding.outputIndex,
      unlockingScriptTemplate: new P2PKH().unlock(key),
    })

    // Output 0: P2PKH to new owner (1 sat)
    tx.addOutput({
      lockingScript: new P2PKH().lock(recipientAddress),
      satoshis: TOKEN_SATS,
    })

    // Output 1: OP_RETURN with updated owner
    tx.addOutput({
      lockingScript: encodeOpReturn({
        tokenName: token.tokenName,
        tokenRules: token.tokenRules,
        tokenAttributes: token.tokenAttributes,
        ownerPubKey: recipientPubKeyHex,
        stateData: token.stateData,
      }),
      satoshis: 0,
    })

    // Output 2: change to sender
    tx.addOutput({
      lockingScript: new P2PKH().lock(myAddress),
      change: true,
    })

    // 5. Fee, sign, broadcast
    await tx.fee(new SatoshisPerKilobyte(1))
    await tx.sign()

    const rawHex = tx.toHex()
    const txId = tx.id('hex') as string
    await this.provider.broadcast(rawHex)

    // 6. Build bundle for recipient
    const updatedToken: OwnedToken = {
      ...token,
      currentTxId: txId,
      currentOutputIndex: 0,
      ownerPubKey: recipientPubKeyHex,
    }
    const bundle: TokenBundle = {
      token: updatedToken,
      proofChain: proofChain ?? { genesisTxId: token.genesisTxId, entries: [] },
    }
    const bundleJson = JSON.stringify(bundle, null, 2)

    // 7. Remove from sender's wallet
    await this.store.removeToken(tokenId)

    return { txId, tokenId, bundleJson }
  }

  /**
   * Import a token bundle received from a peer.
   * Validates the token ID matches the genesis TXID.
   */
  async importBundle(bundleJson: string): Promise<OwnedToken> {
    const bundle: TokenBundle = JSON.parse(bundleJson)
    const { token, proofChain } = bundle

    // Verify token ID
    const expectedId = computeTokenId(token.genesisTxId, token.genesisOutputIndex)
    if (expectedId !== token.tokenId) {
      throw new Error(`Token ID mismatch: expected ${expectedId}, got ${token.tokenId}`)
    }

    await this.store.addToken(token, proofChain)
    return token
  }

  /**
   * Poll for Merkle proof and update the stored proof chain.
   * Returns true once proof is found, false if max attempts exhausted.
   */
  async pollForProof(
    tokenId: string,
    txId: string,
    onStatus?: (msg: string) => void,
    maxAttempts = 60,
    intervalMs = 15000
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      onStatus?.(`Waiting for confirmation... (attempt ${i + 1}/${maxAttempts})`)

      try {
        const proof = await this.provider.getMerkleProof(txId)
        if (!proof) throw new Error('not yet')

        // Update proof chain
        const existing = await this.store.getProofChain(tokenId)
        const token = await this.store.getToken(tokenId)
        if (!token) return false

        let chain: ProofChain
        if (!existing || existing.entries.length === 0) {
          chain = createProofChain(txId, proof)
        } else {
          chain = extendProofChain(existing, proof)
        }

        await this.store.addToken(token, chain)
        onStatus?.('Proof chain updated!')
        return true
      } catch {
        await new Promise(r => setTimeout(r, intervalMs))
      }
    }

    onStatus?.('Timed out waiting for confirmation.')
    return false
  }

  /**
   * Verify a token's proof chain against block headers.
   */
  async verifyToken(tokenId: string): Promise<{ valid: boolean; reason: string }> {
    const token = await this.store.getToken(tokenId)
    if (!token) return { valid: false, reason: 'Token not found' }

    const chain = await this.store.getProofChain(tokenId)
    if (!chain || chain.entries.length === 0) {
      return { valid: false, reason: 'No proof chain (TX may not be confirmed yet)' }
    }

    // Verify token ID
    const expectedId = computeTokenId(token.genesisTxId, token.genesisOutputIndex)
    if (expectedId !== token.tokenId) {
      return { valid: false, reason: 'Token ID does not match genesis' }
    }

    // Verify proof chain
    const { verifyProofChainAsync } = await import('./cryptoCompat')
    const isValid = await verifyProofChainAsync(chain, async (height) => {
      return this.provider.getBlockHeader(height)
    })

    if (!isValid) {
      return { valid: false, reason: 'Proof chain verification failed' }
    }

    return { valid: true, reason: 'Token is valid with verified proof chain' }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function pickLargestUtxo(utxos: Utxo[]): Utxo {
  return [...utxos].sort((a, b) => b.satoshis - a.satoshis)[0]
}
