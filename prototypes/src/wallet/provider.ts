import { MerkleProofEntry } from '../lib/proofChain'

/**
 * A UTXO available for spending.
 */
export interface Utxo {
    txId: string
    outputIndex: number
    satoshis: number
    /** Hex-encoded locking script. */
    script: string
}

/**
 * A BSV block header (subset needed for SPV verification).
 */
export interface BlockHeader {
    height: number
    /** Hex-encoded Merkle root. */
    merkleRoot: string
    /** Hex-encoded block hash. */
    hash: string
    /** Unix timestamp. */
    timestamp: number
    /** Hex-encoded previous block hash. */
    prevHash: string
}

/**
 * Raw transaction bytes ready for signing or broadcasting.
 */
export interface RawTransaction {
    /** Hex-encoded raw transaction. */
    hex: string
    /** Input indices that need signing. */
    inputsToSign: number[]
}

/**
 * A signed transaction ready for broadcasting.
 */
export interface SignedTransaction {
    /** Hex-encoded signed transaction. */
    hex: string
    /** TXID (computed from the signed transaction). */
    txId: string
}

/**
 * WalletProvider — abstract interface for wallet operations.
 *
 * Any BRC-100 compatible wallet (Metanet Desktop, Yours, etc.) can
 * implement this interface. The MPT wallet layer uses it for all
 * external operations: key management, signing, broadcasting, and
 * chain queries.
 *
 * No network calls are made directly by MPT code — everything goes
 * through this interface.
 */
export interface WalletProvider {
    /**
     * Get the wallet's public key (hex-encoded).
     */
    getPublicKey(): Promise<string>

    /**
     * List unspent transaction outputs available for spending.
     * Used to find funding UTXOs for fees.
     */
    getUtxos(): Promise<Utxo[]>

    /**
     * Sign specific inputs of a raw transaction.
     *
     * @param raw - The unsigned transaction with indices to sign.
     * @returns The signed transaction with TXID.
     */
    sign(raw: RawTransaction): Promise<SignedTransaction>

    /**
     * Broadcast a signed transaction to the network.
     *
     * @param tx - The signed transaction.
     * @returns The TXID as confirmed by the network.
     */
    broadcast(tx: SignedTransaction): Promise<string>

    /**
     * Fetch a block header by height.
     * Used for SPV verification of Merkle proofs.
     */
    getBlockHeader(height: number): Promise<BlockHeader>

    /**
     * Fetch the Merkle proof for a mined transaction.
     * Called after a TX is confirmed to obtain its BUMP proof.
     *
     * @param txId - The TXID to get the proof for.
     * @returns The Merkle proof entry for the transaction.
     */
    getMerkleProof(txId: string): Promise<MerkleProofEntry>

    /**
     * Fetch a raw transaction by TXID.
     * Used to retrieve token UTXOs and reconstruct contract state.
     */
    getRawTransaction(txId: string): Promise<string>
}
