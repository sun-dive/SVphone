import { WalletProvider } from './provider'

/**
 * Create a block header verification function for use with verifyProofChain().
 *
 * Returns a callback that fetches block headers from the wallet provider
 * and checks that the Merkle root matches. This is the SPV verification
 * step — the wallet trusts its block header chain, and this function
 * confirms a Merkle root belongs to a real block.
 *
 * Usage:
 *   const verify = createBlockHeaderVerifier(wallet)
 *   const isValid = await verifyProofChain(chain, verify)
 *
 * @param wallet - The wallet provider to fetch block headers from.
 * @returns An async function compatible with verifyProofChain's callback.
 */
export function createBlockHeaderVerifier(
    wallet: WalletProvider
): (merkleRoot: string, blockHeight: number) => Promise<boolean> {
    // Cache fetched headers to avoid repeated network calls
    // when verifying a proof chain with many entries.
    const cache = new Map<number, string>()

    return async (merkleRoot: string, blockHeight: number): Promise<boolean> => {
        let cachedRoot = cache.get(blockHeight)

        if (!cachedRoot) {
            const header = await wallet.getBlockHeader(blockHeight)
            cachedRoot = header.merkleRoot
            cache.set(blockHeight, cachedRoot)
        }

        return cachedRoot === merkleRoot
    }
}

/**
 * Verify a proof chain using a wallet provider for block header lookups.
 *
 * This is a convenience wrapper that combines verifyProofChain() from
 * the core library with block header fetching from the wallet.
 *
 * @param chain   - The proof chain to verify.
 * @param wallet  - The wallet provider for block header access.
 * @returns true if the entire chain is valid.
 */
export async function verifyProofChainWithWallet(
    chain: import('../lib/proofChain').ProofChain,
    wallet: WalletProvider
): Promise<boolean> {
    const { verifyMerkleProof } = await import('../lib/proofChain')
    const verifyHeader = createBlockHeaderVerifier(wallet)

    if (chain.entries.length === 0) return false

    for (const entry of chain.entries) {
        if (!verifyMerkleProof(entry)) return false
        if (!(await verifyHeader(entry.merkleRoot, entry.blockHeight))) return false
    }

    const oldestEntry = chain.entries[chain.entries.length - 1]
    return oldestEntry.txId === chain.genesisTxId
}
