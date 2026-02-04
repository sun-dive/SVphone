/**
 * Token lifecycle manager -- mint, transfer, verify, detect incoming.
 *
 * This module uses:
 *   - walletProvider.ts for all network operations (UTXOs, broadcast, etc.)
 *   - tokenProtocol.ts for all verification (pure SPV, no network)
 *   - tokenStore.ts for persistence
 *   - opReturnCodec.ts for OP_RETURN encoding/decoding
 *
 * Architecture:
 *   Wallet layer (this file + walletProvider) depends on token protocol.
 *   Token protocol NEVER depends on wallet layer.
 */
import { Transaction, P2PKH, PublicKey, LockingScript } from '@bsv/sdk'
import { WalletProvider, Utxo } from './walletProvider'
import { TokenStore, OwnedToken } from './tokenStore'
import {
  computeTokenId,
  createProofChain,
  extendProofChain,
  verifyToken as spvVerifyToken,
  verifyProofChainAsync,
  ProofChain,
  BlockHeader,
  VerificationResult,
} from './tokenProtocol'
import {
  encodeOpReturn,
  decodeOpReturn,
  TokenOpReturnData,
  encodeTokenRules,
} from './opReturnCodec'

// ─── Types ──────────────────────────────────────────────────────────

export interface GenesisParams {
  tokenName: string
  attributes?: string
}

export interface GenesisResult {
  txId: string
  tokenId: string
}

export interface TransferResult {
  txId: string
  tokenId: string
}

// ─── Constants ──────────────────────────────────────────────────────

const TOKEN_SATS = 1
const DEFAULT_FEE_PER_KB = 150
const BYTES_PER_INPUT = 148
const BYTES_PER_P2PKH_OUTPUT = 34
const TX_OVERHEAD = 10

// ─── Token Builder ──────────────────────────────────────────────────

export class TokenBuilder {
  feePerKb = DEFAULT_FEE_PER_KB

  constructor(
    private provider: WalletProvider,
    private store: TokenStore,
  ) {}

  // ── Token UTXO Protection ───────────────────────────────────────

  /**
   * Build a set of "txId:outputIndex" keys for UTXOs currently holding
   * active or pending tokens. These must never be used as funding inputs.
   */
  private async getTokenUtxoKeys(): Promise<Set<string>> {
    const tokens = await this.store.listTokens()
    const keys = new Set<string>()
    for (const t of tokens) {
      if (t.status === 'active' || t.status === 'pending_transfer') {
        keys.add(`${t.currentTxId}:${t.currentOutputIndex}`)
      }
    }
    return keys
  }

  /**
   * Return only UTXOs that are safe to spend as funding inputs.
   *
   * ALL 1-sat UTXOs are permanently quarantined -- never spent as
   * funding inputs. A 1-sat UTXO is almost certainly a token of
   * some kind (MPT, Ordinal, 1Sat Ordinals, etc.) and destroying
   * it by using it as a funding input is irreversible.
   *
   * The only code path that spends a 1-sat UTXO is createTransfer(),
   * which explicitly spends it as Input 0 when the user chooses to
   * transfer a specific known token.
   *
   * For any quarantined 1-sat UTXOs that contain MPT OP_RETURN data
   * addressed to this wallet, we auto-import them into the token store.
   */
  private async getSafeUtxos(): Promise<Utxo[]> {
    const utxos = await this.provider.getUtxos()
    const safe: Utxo[] = []

    for (const u of utxos) {
      if (u.satoshis <= TOKEN_SATS) {
        // Quarantined: attempt MPT auto-import in background, but
        // never allow spending regardless of result
        this.tryAutoImport(u).catch(() => {})
        continue
      }

      safe.push(u)
    }

    return safe
  }

  /**
   * Check if a quarantined UTXO is an incoming MPT token and
   * auto-import it into the store if so. Fire-and-forget.
   */
  private async tryAutoImport(u: Utxo): Promise<void> {
    const utxoKey = `${u.txId}:${u.outputIndex}`
    const tokenKeys = await this.getTokenUtxoKeys()
    if (tokenKeys.has(utxoKey)) return // already known

    const tx = await this.provider.getSourceTransaction(u.txId)
    for (const output of tx.outputs) {
      if (!output.lockingScript) continue
      const opData = decodeOpReturn(output.lockingScript as LockingScript)
      if (!opData) continue
      if (opData.ownerPubKey !== this.provider.getPublicKeyHex()) break

      const genesisTxId = opData.genesisTxId ?? u.txId
      const tid = computeTokenId(genesisTxId, 0)
      const existing = await this.store.getToken(tid)
      if (existing) break

      const token: OwnedToken = {
        tokenId: tid,
        genesisTxId: genesisTxId,
        genesisOutputIndex: 0,
        currentTxId: u.txId,
        currentOutputIndex: u.outputIndex,
        tokenName: opData.tokenName,
        tokenRules: opData.tokenRules,
        tokenAttributes: opData.tokenAttributes,
        ownerPubKey: opData.ownerPubKey,
        stateData: opData.stateData,
        satoshis: TOKEN_SATS,
        status: 'active',
        createdAt: new Date().toISOString(),
      }
      const chain: ProofChain = {
        genesisTxId: genesisTxId,
        entries: opData.proofChainEntries ?? [],
      }
      await this.store.addToken(token, chain)
      console.debug(`tryAutoImport: imported "${opData.tokenName}" from ${u.txId.slice(0, 12)}...`)
      break
    }
  }

  // ── Mint ────────────────────────────────────────────────────────

  async createGenesis(params: GenesisParams): Promise<GenesisResult> {
    const key = this.provider.getPrivateKey()
    const address = this.provider.getAddress()
    const pubKeyHex = this.provider.getPublicKeyHex()

    const utxos = await this.getSafeUtxos()
    if (utxos.length === 0) {
      throw new Error('No spendable UTXOs (token UTXOs are protected). Fund your wallet address first.')
    }

    const tokenRulesHex = encodeTokenRules(1, 0, 0, 1)
    const attrsHex = params.attributes ?? '00'
    const opReturnData: TokenOpReturnData = {
      tokenName: params.tokenName,
      tokenRules: tokenRulesHex,
      tokenAttributes: attrsHex,
      ownerPubKey: pubKeyHex,
      stateData: '',
    }

    const { rawHex, txId, fee } = await this.buildFundedTx(
      utxos, key, address, (t) => {
        t.addOutput({
          lockingScript: new P2PKH().lock(address),
          satoshis: TOKEN_SATS,
        })
        t.addOutput({
          lockingScript: encodeOpReturn(opReturnData),
          satoshis: 0,
        })
      },
    )

    await this.provider.broadcast(rawHex)

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
      status: 'active',
      createdAt: new Date().toISOString(),
      feePaid: fee,
    }

    const emptyChain: ProofChain = { genesisTxId: txId, entries: [] }
    await this.store.addToken(ownedToken, emptyChain)

    return { txId, tokenId }
  }

  // ── Transfer ──────────────────────────────────────────────────

  async createTransfer(tokenId: string, recipientPubKeyHex: string): Promise<TransferResult> {
    const key = this.provider.getPrivateKey()
    const myAddress = this.provider.getAddress()

    const token = await this.store.findToken(tokenId)
    if (!token) throw new Error(`Token not found: ${tokenId}`)
    if (token.status === 'pending_transfer') {
      throw new Error(`Token already has a pending transfer (TXID: ${token.transferTxId}). Confirm or cancel it first.`)
    }
    if (token.status === 'transferred') {
      throw new Error('Token has already been transferred.')
    }

    const actualTokenId = token.tokenId
    const proofChain = await this.store.getProofChain(actualTokenId)
    const tokenSourceTx = await this.provider.getSourceTransaction(token.currentTxId)

    const fundingCandidates = await this.getSafeUtxos()
    if (fundingCandidates.length === 0) {
      throw new Error('No funding UTXOs available (token UTXOs are protected)')
    }

    const recipientPubKey = PublicKey.fromString(recipientPubKeyHex)
    const recipientAddress = recipientPubKey.toAddress()

    const { rawHex, txId, fee } = await this.buildFundedTransferTx(
      tokenSourceTx, token.currentOutputIndex,
      fundingCandidates, key, myAddress, (tx) => {
        tx.addOutput({
          lockingScript: new P2PKH().lock(recipientAddress),
          satoshis: TOKEN_SATS,
        })
        tx.addOutput({
          lockingScript: encodeOpReturn({
            tokenName: token.tokenName,
            tokenRules: token.tokenRules,
            tokenAttributes: token.tokenAttributes,
            ownerPubKey: recipientPubKeyHex,
            stateData: token.stateData,
            genesisTxId: token.genesisTxId,
            proofChainEntries: (proofChain ?? { genesisTxId: token.genesisTxId, entries: [] }).entries,
          }),
          satoshis: 0,
        })
      },
    )

    await this.provider.broadcast(rawHex)

    token.status = 'pending_transfer'
    token.transferTxId = txId
    await this.store.updateToken(token)

    return { txId, tokenId: actualTokenId }
  }

  async confirmTransfer(tokenId: string): Promise<void> {
    const token = await this.store.getToken(tokenId)
    if (!token) throw new Error(`Token not found: ${tokenId}`)
    if (token.status !== 'pending_transfer') {
      throw new Error('Token is not in pending_transfer state')
    }
    token.status = 'transferred'
    await this.store.updateToken(token)
  }

  // ── Send BSV ──────────────────────────────────────────────────

  async sendSats(recipientAddress: string, amount: number): Promise<{ txId: string; fee: number }> {
    const key = this.provider.getPrivateKey()
    const myAddress = this.provider.getAddress()
    if (amount < 1) throw new Error('Amount must be at least 1 satoshi')

    const utxos = await this.getSafeUtxos()
    if (utxos.length === 0) throw new Error('No spendable UTXOs (token UTXOs are protected). Fund your wallet first.')

    const { txId, rawHex, fee } = await this.buildFundedTx(
      utxos, key, myAddress, (tx) => {
        tx.addOutput({
          lockingScript: new P2PKH().lock(recipientAddress),
          satoshis: amount,
        })
      },
    )

    await this.provider.broadcast(rawHex)
    return { txId, fee }
  }

  // ── Proof Polling ─────────────────────────────────────────────

  async pollForProof(
    tokenId: string,
    txId: string,
    onStatus?: (msg: string) => void,
    maxAttempts = 60,
    intervalMs = 15000,
  ): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      onStatus?.(`Waiting for confirmation... (attempt ${i + 1}/${maxAttempts})`)

      try {
        const proof = await this.provider.getMerkleProof(txId)
        if (!proof) throw new Error('not yet')

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

  async fetchMissingProofs(
    onStatus?: (msg: string) => void,
  ): Promise<number> {
    const tokens = await this.store.listTokens()
    let fetched = 0

    for (const token of tokens) {
      if (token.status === 'transferred') continue

      const chain = await this.store.getProofChain(token.tokenId)
      if (chain && chain.entries.length > 0) continue

      const txId = token.currentTxId
      onStatus?.(`Fetching proof for ${token.tokenName}...`)

      try {
        const proof = await this.provider.getMerkleProof(txId)
        if (!proof) {
          console.debug(`fetchMissingProofs: no proof yet for ${token.tokenName} (${txId.slice(0, 12)}...)`)
          continue
        }

        const newChain = createProofChain(token.genesisTxId, proof)
        await this.store.addToken(token, newChain)
        fetched++
        onStatus?.(`Got proof for ${token.tokenName}`)
      } catch (e) {
        console.warn(`fetchMissingProofs: error fetching proof for ${token.tokenName}:`, e)
        continue
      }
    }

    return fetched
  }

  // ── Incoming Token Detection ──────────────────────────────────

  async checkIncomingTokens(
    onStatus?: (msg: string) => void,
  ): Promise<OwnedToken[]> {
    const myPubKey = this.provider.getPublicKeyHex()
    onStatus?.('Fetching transactions...')

    const [history, utxos] = await Promise.all([
      this.provider.getAddressHistory(),
      this.provider.getUtxos(),
    ])

    const txIdSet = new Set<string>()
    for (const h of history) txIdSet.add(h.txId)
    for (const u of utxos) txIdSet.add(u.txId)

    const allTxIds = Array.from(txIdSet)
    if (allTxIds.length === 0) {
      onStatus?.('No transactions found.')
      return []
    }

    const imported: OwnedToken[] = []
    const existingTokens = await this.store.listTokens()
    const existingTxIds = new Set(existingTokens.map(t => t.currentTxId))

    onStatus?.(`Scanning ${allTxIds.length} transactions...`)

    for (const txId of allTxIds) {
      if (existingTxIds.has(txId)) continue

      try {
        const tx = await this.provider.getSourceTransaction(txId)

        for (const output of tx.outputs) {
          if (!output.lockingScript) continue

          const opData = decodeOpReturn(output.lockingScript as LockingScript)
          if (!opData) continue
          if (opData.ownerPubKey !== myPubKey) continue
          if (!opData.genesisTxId) continue

          const detectedTokenId = computeTokenId(opData.genesisTxId, 0)
          const existing = await this.store.getToken(detectedTokenId)
          if (existing) continue

          const token: OwnedToken = {
            tokenId: detectedTokenId,
            genesisTxId: opData.genesisTxId,
            genesisOutputIndex: 0,
            currentTxId: txId,
            currentOutputIndex: 0,
            tokenName: opData.tokenName,
            tokenRules: opData.tokenRules,
            tokenAttributes: opData.tokenAttributes,
            ownerPubKey: opData.ownerPubKey,
            stateData: opData.stateData,
            satoshis: TOKEN_SATS,
            status: 'active',
            createdAt: new Date().toISOString(),
          }

          const proofChain: ProofChain = {
            genesisTxId: opData.genesisTxId,
            entries: opData.proofChainEntries ?? [],
          }

          await this.store.addToken(token, proofChain)
          imported.push(token)
          onStatus?.(`Found token: ${token.tokenName} (${detectedTokenId.slice(0, 12)}...)`)
        }
      } catch (e) {
        console.debug(`checkIncoming: skipping TX ${txId}:`, e)
        continue
      }
    }

    onStatus?.(imported.length > 0
      ? `Done! Imported ${imported.length} token(s).`
      : 'No new incoming tokens found.')
    return imported
  }

  // ── Verification (delegates to SPV token protocol) ────────────

  /**
   * Verify a token using the pure SPV protocol.
   *
   * Fetches block headers from the wallet provider, then hands
   * everything to tokenProtocol.verifyToken() which does the
   * actual cryptographic verification with no network calls.
   */
  async verifyToken(tokenId: string): Promise<VerificationResult> {
    const token = await this.store.getToken(tokenId)
    if (!token) return { valid: false, reason: 'Token not found' }

    let chain = await this.store.getProofChain(tokenId)

    // If no proof chain stored, try to fetch one on demand
    if (!chain || chain.entries.length === 0) {
      try {
        const proof = await this.provider.getMerkleProof(token.currentTxId)
        if (proof) {
          chain = createProofChain(token.genesisTxId, proof)
          await this.store.addToken(token, chain)
        }
      } catch (e) {
        console.warn('verifyToken: failed to fetch Merkle proof on demand:', e)
      }
    }

    if (!chain || chain.entries.length === 0) {
      return { valid: false, reason: 'No proof chain (TX may not be confirmed yet)' }
    }

    // Verify token ID (pure computation)
    const expectedId = computeTokenId(token.genesisTxId, token.genesisOutputIndex)
    if (expectedId !== token.tokenId) {
      return { valid: false, reason: 'Token ID does not match genesis' }
    }

    // Fetch needed block headers, then verify using pure SPV protocol
    // The async version fetches headers via callback; the actual
    // Merkle proof verification inside is pure crypto.
    return verifyProofChainAsync(chain, async (height) => {
      return this.provider.getBlockHeader(height)
    })
  }

  // ── Transaction Building (wallet internals) ───────────────────

  private async buildFundedTx(
    utxos: Utxo[],
    key: ReturnType<WalletProvider['getPrivateKey']>,
    changeAddress: string,
    addOutputs: (tx: Transaction) => void,
  ): Promise<{ tx: Transaction; rawHex: string; txId: string; fee: number }> {
    const sorted = [...utxos].sort((a, b) => a.satoshis - b.satoshis)

    const combos: Utxo[][] = []
    for (const u of sorted) combos.push([u])
    if (sorted.length >= 2) {
      for (let i = 0; i < sorted.length; i++)
        for (let j = i + 1; j < sorted.length; j++)
          combos.push([sorted[i], sorted[j]])
    }
    if (sorted.length >= 3) {
      for (let i = 0; i < sorted.length; i++)
        for (let j = i + 1; j < sorted.length; j++)
          for (let k = j + 1; k < sorted.length; k++)
            combos.push([sorted[i], sorted[j], sorted[k]])
    }

    combos.sort((a, b) =>
      a.reduce((s, u) => s + u.satoshis, 0) - b.reduce((s, u) => s + u.satoshis, 0)
    )

    let lastError = ''
    for (const combo of combos) {
      const tx = new Transaction()

      for (const u of combo) {
        const sourceTx = await this.provider.getSourceTransaction(u.txId)
        tx.addInput({
          sourceTransaction: sourceTx,
          sourceOutputIndex: u.outputIndex,
          unlockingScriptTemplate: new P2PKH().unlock(key),
        })
      }

      addOutputs(tx)

      const fee = estimateFee(combo.length, tx.outputs.length + 1, tx.outputs, this.feePerKb)
      const totalIn = combo.reduce((s, u) => s + u.satoshis, 0)
      const protocolOut = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0)
      const changeAmount = totalIn - protocolOut - fee

      if (changeAmount < 0) {
        lastError = `${combo.length} UTXO(s) totalling ${totalIn} sats too small for fees (need ${fee} sats)`
        continue
      }

      tx.addOutput({
        lockingScript: new P2PKH().lock(changeAddress),
        satoshis: changeAmount,
      })

      await tx.sign()

      return {
        tx,
        rawHex: tx.toHex(),
        txId: tx.id('hex') as string,
        fee,
      }
    }

    const totalBalance = utxos.reduce((s, u) => s + u.satoshis, 0)
    throw new Error(
      `Insufficient balance (${totalBalance} sats) to cover transaction fees. ${lastError}`
    )
  }

  private async buildFundedTransferTx(
    tokenSourceTx: Transaction,
    tokenOutputIndex: number,
    fundingUtxos: Utxo[],
    key: ReturnType<WalletProvider['getPrivateKey']>,
    changeAddress: string,
    addOutputs: (tx: Transaction) => void,
  ): Promise<{ tx: Transaction; rawHex: string; txId: string; fee: number }> {
    const sorted = [...fundingUtxos].sort((a, b) => a.satoshis - b.satoshis)

    const combos: Utxo[][] = []
    for (const u of sorted) combos.push([u])
    if (sorted.length >= 2) {
      for (let i = 0; i < sorted.length; i++)
        for (let j = i + 1; j < sorted.length; j++)
          combos.push([sorted[i], sorted[j]])
    }
    if (sorted.length >= 3) {
      for (let i = 0; i < sorted.length; i++)
        for (let j = i + 1; j < sorted.length; j++)
          for (let k = j + 1; k < sorted.length; k++)
            combos.push([sorted[i], sorted[j], sorted[k]])
    }

    combos.sort((a, b) =>
      a.reduce((s, u) => s + u.satoshis, 0) - b.reduce((s, u) => s + u.satoshis, 0)
    )

    let lastError = ''
    for (const combo of combos) {
      const tx = new Transaction()

      tx.addInput({
        sourceTransaction: tokenSourceTx,
        sourceOutputIndex: tokenOutputIndex,
        unlockingScriptTemplate: new P2PKH().unlock(key),
      })

      for (const u of combo) {
        const sourceTx = await this.provider.getSourceTransaction(u.txId)
        tx.addInput({
          sourceTransaction: sourceTx,
          sourceOutputIndex: u.outputIndex,
          unlockingScriptTemplate: new P2PKH().unlock(key),
        })
      }

      addOutputs(tx)

      const numInputs = 1 + combo.length
      const fee = estimateFee(numInputs, tx.outputs.length + 1, tx.outputs, this.feePerKb)
      const totalIn = TOKEN_SATS + combo.reduce((s, u) => s + u.satoshis, 0)
      const protocolOut = tx.outputs.reduce((s, o) => s + (o.satoshis ?? 0), 0)
      const changeAmount = totalIn - protocolOut - fee

      if (changeAmount < 0) {
        const fundingSats = combo.reduce((s, u) => s + u.satoshis, 0)
        lastError = `${combo.length} funding UTXO(s) totalling ${fundingSats} sats too small for fees (need ${fee} sats)`
        continue
      }

      tx.addOutput({
        lockingScript: new P2PKH().lock(changeAddress),
        satoshis: changeAmount,
      })

      await tx.sign()

      return {
        tx,
        rawHex: tx.toHex(),
        txId: tx.id('hex') as string,
        fee,
      }
    }

    const totalFunding = fundingUtxos.reduce((s, u) => s + u.satoshis, 0)
    throw new Error(
      `Insufficient funding balance (${totalFunding} sats) to cover transfer fees. ${lastError}`
    )
  }
}

// ─── Fee Estimation ─────────────────────────────────────────────────

function estimateFee(
  numInputs: number,
  numOutputs: number,
  existingOutputs: { lockingScript?: { toBinary(): number[] }; satoshis?: number }[],
  feePerKb: number,
): number {
  let size = TX_OVERHEAD + numInputs * BYTES_PER_INPUT

  for (const o of existingOutputs) {
    const scriptLen = o.lockingScript?.toBinary()?.length ?? 25
    size += 8 + 1 + scriptLen
  }

  size += BYTES_PER_P2PKH_OUTPUT

  return Math.ceil(size * feePerKb / 1000)
}
