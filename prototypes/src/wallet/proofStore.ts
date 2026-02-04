import { ProofChain } from '../lib/proofChain'

/**
 * Pluggable storage backend for token data and proof chains.
 *
 * Implement this for your environment:
 *   - File system for Node.js / desktop apps
 *   - IndexedDB for browser apps
 *   - In-memory for tests
 */
export interface StorageBackend {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
}

/**
 * In-memory storage backend for testing.
 */
export class MemoryStorage implements StorageBackend {
    private store = new Map<string, string>()

    async get(key: string): Promise<string | null> {
        return this.store.get(key) ?? null
    }

    async set(key: string, value: string): Promise<void> {
        this.store.set(key, value)
    }

    async delete(key: string): Promise<void> {
        this.store.delete(key)
    }

    async keys(): Promise<string[]> {
        return Array.from(this.store.keys())
    }
}

const PROOF_PREFIX = 'proof:'

/**
 * Local proof chain persistence.
 *
 * Stores and retrieves proof chains keyed by Token ID.
 * No server, no overlay — everything is local.
 */
export class ProofStore {
    constructor(private storage: StorageBackend) {}

    /**
     * Save a proof chain for a token.
     */
    async save(tokenId: string, chain: ProofChain): Promise<void> {
        await this.storage.set(
            PROOF_PREFIX + tokenId,
            JSON.stringify(chain)
        )
    }

    /**
     * Load a proof chain for a token.
     * Returns null if not found.
     */
    async load(tokenId: string): Promise<ProofChain | null> {
        const data = await this.storage.get(PROOF_PREFIX + tokenId)
        if (!data) return null
        return JSON.parse(data) as ProofChain
    }

    /**
     * Delete a proof chain (e.g. after transferring the token out).
     */
    async delete(tokenId: string): Promise<void> {
        await this.storage.delete(PROOF_PREFIX + tokenId)
    }

    /**
     * List all stored token IDs.
     */
    async listTokenIds(): Promise<string[]> {
        const allKeys = await this.storage.keys()
        return allKeys
            .filter((k) => k.startsWith(PROOF_PREFIX))
            .map((k) => k.slice(PROOF_PREFIX.length))
    }
}
