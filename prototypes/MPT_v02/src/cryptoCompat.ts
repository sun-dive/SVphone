/**
 * Browser-compatible crypto functions for MPT prototype.
 *
 * Reimplements tokenId and proofChain logic using @bsv/sdk Hash
 * instead of Node.js crypto module.
 */
import { Hash } from '@bsv/sdk'

// ─── Types (same as src/lib/proofChain.ts) ──────────────────────────

export interface MerklePathNode {
  hash: string
  position: 'L' | 'R'
}

export interface MerkleProofEntry {
  txId: string
  blockHeight: number
  merkleRoot: string
  path: MerklePathNode[]
}

export interface ProofChain {
  genesisTxId: string
  entries: MerkleProofEntry[]
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert hex string to number array. */
function hexToBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16))
  }
  return bytes
}

/** Convert number array to hex string. */
function bytesToHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Write a 32-bit unsigned integer as 4-byte little-endian. */
function uint32LE(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

/** Bitcoin double SHA-256. */
export function doubleSha256(data: number[]): number[] {
  const first = Hash.sha256(data)
  return Hash.sha256(first)
}

// ─── Token ID ───────────────────────────────────────────────────────

/**
 * Compute Token ID = SHA-256(Genesis TXID bytes || Output Index as 4-byte LE).
 * Same logic as src/lib/tokenId.ts but browser-compatible.
 */
export function computeTokenId(genesisTxId: string, outputIndex: number): string {
  const txIdBytes = hexToBytes(genesisTxId)
  const indexBytes = uint32LE(outputIndex)
  const combined = [...txIdBytes, ...indexBytes]
  const hash = Hash.sha256(combined)
  return bytesToHex(hash)
}

// ─── Merkle Proof Verification ──────────────────────────────────────

/**
 * Verify a single Merkle proof against a known Merkle root.
 * Uses Bitcoin double SHA-256 for the Merkle tree.
 */
export function verifyMerkleProof(entry: MerkleProofEntry): boolean {
  let currentHash = hexToBytes(entry.txId)

  for (const node of entry.path) {
    const sibling = hexToBytes(node.hash)
    let combined: number[]

    if (node.position === 'R') {
      combined = [...currentHash, ...sibling]
    } else {
      combined = [...sibling, ...currentHash]
    }

    currentHash = doubleSha256(combined)
  }

  const computedRoot = bytesToHex(currentHash)
  return computedRoot === entry.merkleRoot
}

/**
 * Verify an entire proof chain from most recent transfer back to genesis.
 */
export function verifyProofChain(
  chain: ProofChain,
  verifyBlockHeader: (merkleRoot: string, blockHeight: number) => boolean
): boolean {
  if (chain.entries.length === 0) return false

  for (const entry of chain.entries) {
    if (!verifyMerkleProof(entry)) return false
    if (!verifyBlockHeader(entry.merkleRoot, entry.blockHeight)) return false
  }

  const oldestEntry = chain.entries[chain.entries.length - 1]
  return oldestEntry.txId === chain.genesisTxId
}

/**
 * Async version of verifyProofChain that fetches block headers.
 */
export async function verifyProofChainAsync(
  chain: ProofChain,
  getBlockHeader: (height: number) => Promise<{ merkleRoot: string }>
): Promise<boolean> {
  if (chain.entries.length === 0) return false

  for (const entry of chain.entries) {
    if (!verifyMerkleProof(entry)) return false
    const header = await getBlockHeader(entry.blockHeight)
    if (header.merkleRoot !== entry.merkleRoot) return false
  }

  const oldestEntry = chain.entries[chain.entries.length - 1]
  return oldestEntry.txId === chain.genesisTxId
}

/**
 * Create an initial proof chain from the genesis TX's Merkle proof.
 */
export function createProofChain(
  genesisTxId: string,
  genesisProof: MerkleProofEntry
): ProofChain {
  return { genesisTxId, entries: [genesisProof] }
}

/**
 * Extend an existing proof chain with a new transfer's Merkle proof.
 */
export function extendProofChain(
  chain: ProofChain,
  newEntry: MerkleProofEntry
): ProofChain {
  return {
    genesisTxId: chain.genesisTxId,
    entries: [newEntry, ...chain.entries],
  }
}
