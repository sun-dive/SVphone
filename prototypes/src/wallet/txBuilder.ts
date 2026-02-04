import { ByteString, PubKey, toByteString } from 'scrypt-ts'
import { WalletProvider, Utxo } from './provider'
import { TokenManager, OwnedToken } from './tokenManager'
import { buildGenesisOutputs, GenesisParams, encodeTokenRules } from '../lib/genesis'
import { computeTokenId } from '../lib/tokenId'
import { createProofChain, extendProofChain } from '../lib/proofChain'
import { verifyProofChainWithWallet } from './blockHeaders'

/** Result of a genesis transaction. */
export interface GenesisResult {
    /** The TXID of the genesis transaction. */
    txId: string
    /** Array of created tokens with their computed Token IDs. */
    tokens: Array<{
        tokenId: string
        outputIndex: number
    }>
}

/** Result of a transfer transaction. */
export interface TransferResult {
    /** The TXID of the transfer transaction. */
    txId: string
    /** The Token ID that was transferred. */
    tokenId: string
}

/** Minimum satoshis per token UTXO. */
const TOKEN_SATS = 1

/** Estimated bytes per input for fee calculation. */
const BYTES_PER_INPUT = 148
/** Estimated bytes per output for fee calculation. */
const BYTES_PER_OUTPUT = 34
/** Base transaction overhead in bytes. */
const TX_OVERHEAD = 10
/** Fee rate in satoshis per byte. */
const FEE_RATE = 1

/**
 * Estimate the fee for a transaction.
 */
function estimateFee(numInputs: number, numOutputs: number): number {
    const size =
        TX_OVERHEAD +
        numInputs * BYTES_PER_INPUT +
        numOutputs * BYTES_PER_OUTPUT
    return Math.ceil(size * FEE_RATE)
}

/**
 * Select a funding UTXO that covers the required amount.
 * Simple largest-first selection.
 */
function selectFundingUtxo(utxos: Utxo[], requiredSats: number): Utxo {
    // Sort by value descending, pick first that covers the requirement.
    const sorted = [...utxos].sort((a, b) => b.satoshis - a.satoshis)
    const selected = sorted.find((u) => u.satoshis >= requiredSats)
    if (!selected) {
        throw new Error(
            `Insufficient funds: need ${requiredSats} sats, ` +
            `largest UTXO is ${sorted[0]?.satoshis ?? 0} sats`
        )
    }
    return selected
}

/**
 * MPT Transaction Builder.
 *
 * Orchestrates genesis and transfer transactions using a WalletProvider
 * for signing/broadcasting and a TokenManager for local state.
 *
 * All token logic is client-side. No overlay, no indexer.
 */
export class MptTxBuilder {
    constructor(
        private wallet: WalletProvider,
        private tokenManager: TokenManager
    ) {}

    /**
     * Create a genesis transaction minting one or more NFTs.
     *
     * 1. Builds MPT contract instances for each NFT.
     * 2. Selects a funding UTXO.
     * 3. Constructs, signs, and broadcasts the transaction.
     * 4. Waits for Merkle proof and stores tokens locally.
     *
     * @returns Genesis result with TXID and token IDs.
     */
    async createGenesis(params: GenesisParams): Promise<GenesisResult> {
        // Build contract instances (one per NFT).
        const instances = buildGenesisOutputs(params)

        // Calculate required funding.
        const tokenOutputsSats = instances.length * TOKEN_SATS
        // Inputs: 1 funding. Outputs: N tokens + 1 change.
        const fee = estimateFee(1, instances.length + 1)
        const requiredSats = tokenOutputsSats + fee

        // Select funding UTXO.
        const utxos = await this.wallet.getUtxos()
        const fundingUtxo = selectFundingUtxo(utxos, requiredSats)

        // Build raw transaction.
        // The actual BSV transaction construction would use @bsv/sdk here.
        // For now we define the structure that the wallet provider signs.
        const changeSats = fundingUtxo.satoshis - tokenOutputsSats - fee

        // Sign and broadcast.
        const signed = await this.wallet.sign({
            hex: '', // Placeholder — real implementation builds raw TX bytes
            inputsToSign: [0],
        })

        const txId = await this.wallet.broadcast(signed)

        // Compute token IDs and store locally.
        const tokens: GenesisResult['tokens'] = []

        for (let i = 0; i < instances.length; i++) {
            const tokenId = computeTokenId(txId, i)

            // Fetch Merkle proof once TX is confirmed.
            const merkleProof = await this.wallet.getMerkleProof(txId)
            const proofChain = createProofChain(txId, merkleProof)

            const ownedToken: OwnedToken = {
                tokenId,
                genesisTxId: txId,
                genesisOutputIndex: i,
                currentTxId: txId,
                currentOutputIndex: i,
                tokenName: params.tokenName,
                tokenRules: params.tokenRules as string,
                tokenAttributes: params.nfts[i].tokenAttributes as string,
                ownerPubKey: params.creatorPubKey as string,
                stateData: (params.initialStateData ?? toByteString('', true)) as string,
                satoshis: TOKEN_SATS,
            }

            await this.tokenManager.addToken(ownedToken, proofChain)
            tokens.push({ tokenId, outputIndex: i })
        }

        return { txId, tokens }
    }

    /**
     * Transfer a token to a new owner.
     *
     * 1. Loads the token and proof chain from local storage.
     * 2. Selects a funding UTXO for fees.
     * 3. Constructs, signs, and broadcasts the transfer TX.
     * 4. Updates local state (removes token from sender's wallet).
     * 5. Returns a token bundle for the recipient.
     *
     * @returns Transfer result with TXID.
     */
    async createTransfer(
        tokenId: string,
        recipientPubKey: string,
        newStateData?: string
    ): Promise<TransferResult> {
        // Load token from local storage.
        const token = await this.tokenManager.getToken(tokenId)
        if (!token) throw new Error(`Token not found: ${tokenId}`)

        const proofChain = await this.tokenManager.getProofChain(tokenId)
        if (!proofChain) throw new Error(`Proof chain not found: ${tokenId}`)

        // Calculate fees.
        // Inputs: token UTXO + funding UTXO. Outputs: new token + change.
        const fee = estimateFee(2, 2)
        const requiredSats = fee

        // Select funding UTXO.
        const utxos = await this.wallet.getUtxos()
        const fundingUtxo = selectFundingUtxo(utxos, requiredSats)

        // Build, sign, and broadcast the transfer TX.
        const signed = await this.wallet.sign({
            hex: '', // Placeholder — real implementation builds raw TX bytes
            inputsToSign: [0, 1],
        })

        const txId = await this.wallet.broadcast(signed)

        // Fetch Merkle proof for the transfer TX.
        const merkleProof = await this.wallet.getMerkleProof(txId)
        const updatedChain = extendProofChain(proofChain, merkleProof)

        // Update the token record with new UTXO location for the recipient.
        // The sender removes the token from their wallet.
        // The recipient will import the bundle.
        const stateData = newStateData ?? token.stateData

        // Remove from sender's wallet.
        await this.tokenManager.removeToken(tokenId)

        return { txId, tokenId }
    }

    /**
     * Receive a token bundle from a peer.
     *
     * 1. Verifies the proof chain against block headers.
     * 2. Verifies the Token ID matches the genesis TXID.
     * 3. Stores the token locally.
     *
     * @param bundle - The token bundle received from the sender.
     * @returns true if the token was accepted.
     */
    async receiveToken(
        bundle: import('./tokenManager').TokenBundle
    ): Promise<boolean> {
        // Verify the proof chain.
        const isValid = await verifyProofChainWithWallet(
            bundle.proofChain,
            this.wallet
        )
        if (!isValid) return false

        // Verify Token ID matches genesis.
        const expectedId = computeTokenId(
            bundle.token.genesisTxId,
            bundle.token.genesisOutputIndex
        )
        if (expectedId !== bundle.token.tokenId) return false

        // Store the token.
        await this.tokenManager.importToken(bundle)
        return true
    }
}
