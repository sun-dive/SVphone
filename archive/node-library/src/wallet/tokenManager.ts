import { ProofChain } from '../lib/proofChain'
import { StorageBackend } from './proofStore'
import { ProofStore } from './proofStore'

/**
 * Serialisable representation of a token held in the wallet.
 * Contains everything needed to prove ownership and transfer.
 */
export interface OwnedToken {
    /** Computed Token ID: SHA-256(Genesis TXID || Output Index). */
    tokenId: string
    /** Genesis TXID. */
    genesisTxId: string
    /** Output index in the genesis TX. */
    genesisOutputIndex: number
    /** Current UTXO TXID (may differ from genesis after transfers). */
    currentTxId: string
    /** Current UTXO output index. */
    currentOutputIndex: number
    /** Token name (from immutable fields). */
    tokenName: string
    /** Hex-encoded token rules. */
    tokenRules: string
    /** Hex-encoded token attributes. */
    tokenAttributes: string
    /** Hex-encoded current owner public key. */
    ownerPubKey: string
    /** Hex-encoded state data. */
    stateData: string
    /** Satoshis held in the token UTXO. */
    satoshis: number
}

/**
 * A token bundle — self-contained package for peer-to-peer transfer.
 * Contains the token data and its full proof chain.
 */
export interface TokenBundle {
    token: OwnedToken
    proofChain: ProofChain
}

const TOKEN_PREFIX = 'token:'

/**
 * Manages owned MPT tokens client-side.
 *
 * All state is local — no overlay server, no indexer.
 * Tokens and proof chains are stored via pluggable StorageBackend.
 */
export class TokenManager {
    private proofStore: ProofStore

    constructor(private storage: StorageBackend) {
        this.proofStore = new ProofStore(storage)
    }

    /**
     * Add a token to the wallet (e.g. after genesis or receiving a transfer).
     */
    async addToken(token: OwnedToken, proofChain: ProofChain): Promise<void> {
        await this.storage.set(
            TOKEN_PREFIX + token.tokenId,
            JSON.stringify(token)
        )
        await this.proofStore.save(token.tokenId, proofChain)
    }

    /**
     * Remove a token from the wallet (e.g. after transferring out).
     */
    async removeToken(tokenId: string): Promise<void> {
        await this.storage.delete(TOKEN_PREFIX + tokenId)
        await this.proofStore.delete(tokenId)
    }

    /**
     * Get a single token by ID. Returns null if not found.
     */
    async getToken(tokenId: string): Promise<OwnedToken | null> {
        const data = await this.storage.get(TOKEN_PREFIX + tokenId)
        if (!data) return null
        return JSON.parse(data) as OwnedToken
    }

    /**
     * Get the proof chain for a token. Returns null if not found.
     */
    async getProofChain(tokenId: string): Promise<ProofChain | null> {
        return this.proofStore.load(tokenId)
    }

    /**
     * List all owned tokens.
     */
    async listTokens(): Promise<OwnedToken[]> {
        const allKeys = await this.storage.keys()
        const tokenKeys = allKeys.filter((k) => k.startsWith(TOKEN_PREFIX))
        const tokens: OwnedToken[] = []

        for (const key of tokenKeys) {
            const data = await this.storage.get(key)
            if (data) {
                tokens.push(JSON.parse(data) as OwnedToken)
            }
        }

        return tokens
    }

    /**
     * Update a token's current UTXO location (after a transfer is confirmed).
     */
    async updateTokenUtxo(
        tokenId: string,
        newTxId: string,
        newOutputIndex: number,
        newOwnerPubKey: string,
        newStateData: string
    ): Promise<void> {
        const token = await this.getToken(tokenId)
        if (!token) throw new Error(`Token not found: ${tokenId}`)

        token.currentTxId = newTxId
        token.currentOutputIndex = newOutputIndex
        token.ownerPubKey = newOwnerPubKey
        token.stateData = newStateData

        await this.storage.set(
            TOKEN_PREFIX + tokenId,
            JSON.stringify(token)
        )
    }

    /**
     * Export a token as a self-contained bundle for peer-to-peer transfer.
     * The recipient can import this to verify and claim the token.
     */
    async exportToken(tokenId: string): Promise<TokenBundle> {
        const token = await this.getToken(tokenId)
        if (!token) throw new Error(`Token not found: ${tokenId}`)

        const proofChain = await this.getProofChain(tokenId)
        if (!proofChain) throw new Error(`Proof chain not found: ${tokenId}`)

        return { token, proofChain }
    }

    /**
     * Import a token bundle received from a peer.
     * The caller should verify the proof chain before calling this.
     */
    async importToken(bundle: TokenBundle): Promise<void> {
        await this.addToken(bundle.token, bundle.proofChain)
    }
}
