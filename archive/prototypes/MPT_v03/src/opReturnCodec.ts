/**
 * OP_RETURN encoder/decoder for MPT token metadata.
 *
 * Format: OP_0 OP_RETURN <"MPT"> <version:1> <tokenName> <tokenRules:8>
 *         <tokenAttributes> <ownerPubKey:33> <stateData>
 *
 * Transfer TXs add two extra fields:
 *   <genesisTxId:32> <proofChainBinary>
 *
 * Proof chain binary layout:
 *   [1 byte: entry count]
 *   Per entry:
 *     [32 bytes: txId]
 *     [4 bytes: blockHeight LE]
 *     [32 bytes: merkleRoot]
 *     [1 byte: path node count]
 *     Per node:
 *       [32 bytes: hash]
 *       [1 byte: 0=L, 1=R]
 *
 * Each field is a separate pushdata chunk.
 */
import { LockingScript, OP } from '@bsv/sdk'
import type { MerkleProofEntry, MerklePathNode } from './tokenProtocol'

// ─── Constants ──────────────────────────────────────────────────────

interface ScriptChunk {
  op: number
  data?: number[]
}

export const MPT_PREFIX = [0x4d, 0x50, 0x54] // "MPT" in ASCII
export const MPT_VERSION = 0x01

export interface TokenOpReturnData {
  tokenName: string       // UTF-8 text
  tokenRules: string      // hex, 8 bytes
  tokenAttributes: string // hex, variable
  ownerPubKey: string     // hex, 33 bytes compressed pubkey
  stateData: string       // hex, variable (can be empty)
  genesisTxId?: string    // hex, 32 bytes -- present on transfer TXs
  proofChainEntries?: MerkleProofEntry[]
}

// ─── Helpers ────────────────────────────────────────────────────────

function hexToBytes(hex: string): number[] {
  if (hex.length === 0) return []
  const bytes: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16))
  }
  return bytes
}

function bytesToHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

function stringToBytes(str: string): number[] {
  return Array.from(new TextEncoder().encode(str))
}

function bytesToString(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** Create a pushdata chunk with correct OP_PUSHDATA encoding. */
function pushData(data: number[]): ScriptChunk {
  const len = data.length
  let op: number
  if (len > 0 && len < OP.OP_PUSHDATA1) {
    op = len // opcodes 1-75 mean "push next N bytes"
  } else if (len < 256) {
    op = OP.OP_PUSHDATA1
  } else if (len < 65536) {
    op = OP.OP_PUSHDATA2
  } else {
    op = OP.OP_PUSHDATA4
  }
  return { op, data } as ScriptChunk
}

// ─── Proof Chain Binary Codec ───────────────────────────────────────

function uint32LE(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

function readUint32LE(bytes: number[], offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0
}

/**
 * Encode proof chain entries to compact binary.
 *
 * Layout: [1B entryCount] per entry: [32B txId][4B height LE][32B merkleRoot]
 *         [1B nodeCount] per node: [32B hash][1B position]
 */
export function encodeProofChainBinary(entries: MerkleProofEntry[]): number[] {
  const buf: number[] = [entries.length & 0xff]
  for (const entry of entries) {
    buf.push(...hexToBytes(entry.txId))
    buf.push(...uint32LE(entry.blockHeight))
    buf.push(...hexToBytes(entry.merkleRoot))
    buf.push(entry.path.length & 0xff)
    for (const node of entry.path) {
      buf.push(...hexToBytes(node.hash))
      buf.push(node.position === 'L' ? 0 : 1)
    }
  }
  return buf
}

/** Decode proof chain entries from compact binary. */
export function decodeProofChainBinary(bytes: number[]): MerkleProofEntry[] {
  if (bytes.length === 0) return []
  const entries: MerkleProofEntry[] = []
  let offset = 0
  const entryCount = bytes[offset++]

  for (let i = 0; i < entryCount; i++) {
    const txId = bytesToHex(bytes.slice(offset, offset + 32)); offset += 32
    const blockHeight = readUint32LE(bytes, offset); offset += 4
    const merkleRoot = bytesToHex(bytes.slice(offset, offset + 32)); offset += 32
    const nodeCount = bytes[offset++]

    const path: MerklePathNode[] = []
    for (let j = 0; j < nodeCount; j++) {
      const hash = bytesToHex(bytes.slice(offset, offset + 32)); offset += 32
      const position: 'L' | 'R' = bytes[offset++] === 0 ? 'L' : 'R'
      path.push({ hash, position })
    }
    entries.push({ txId, blockHeight, merkleRoot, path })
  }
  return entries
}

// ─── Encode ─────────────────────────────────────────────────────────

/** Build an OP_RETURN locking script containing MPT token metadata. */
export function encodeOpReturn(data: TokenOpReturnData): LockingScript {
  const nameBytes = stringToBytes(data.tokenName)
  const rulesBytes = hexToBytes(data.tokenRules)
  const attrsBytes = hexToBytes(data.tokenAttributes)
  const ownerBytes = hexToBytes(data.ownerPubKey)
  const stateBytes = data.stateData ? hexToBytes(data.stateData) : []

  const chunks: ScriptChunk[] = [
    { op: OP.OP_0 },
    { op: OP.OP_RETURN },
    pushData(MPT_PREFIX),
    pushData([MPT_VERSION]),
    pushData(nameBytes),
    pushData(rulesBytes),
    pushData(attrsBytes),
    pushData(ownerBytes),
    pushData(stateBytes.length > 0 ? stateBytes : [0x00]),
  ]

  // Optional on-chain bundle fields (transfer TXs only)
  if (data.genesisTxId) {
    chunks.push(pushData(hexToBytes(data.genesisTxId)))
    chunks.push(pushData(encodeProofChainBinary(data.proofChainEntries ?? [])))
  }

  return new LockingScript(chunks)
}

// ─── Decode ─────────────────────────────────────────────────────────

/** Parse an OP_RETURN locking script back into token metadata. */
export function decodeOpReturn(script: LockingScript): TokenOpReturnData | null {
  const chunks = script.chunks

  // Minimum: OP_0 OP_RETURN MPT version name rules attrs owner state = 9 chunks
  if (chunks.length < 9) return null

  // Check OP_0 OP_RETURN
  if (chunks[0].op !== OP.OP_0) return null
  if (chunks[1].op !== OP.OP_RETURN) return null

  // Check MPT prefix
  const prefix = chunks[2].data ?? []
  if (prefix.length !== 3 || prefix[0] !== 0x4d || prefix[1] !== 0x50 || prefix[2] !== 0x54) {
    return null
  }

  // Check version
  const versionData = chunks[3].data ?? []
  if (versionData.length !== 1 || versionData[0] !== MPT_VERSION) return null

  const tokenName = bytesToString((chunks[4].data ?? []) as number[])
  const tokenRules = bytesToHex((chunks[5].data ?? []) as number[])
  const tokenAttributes = bytesToHex((chunks[6].data ?? []) as number[])
  const ownerPubKey = bytesToHex((chunks[7].data ?? []) as number[])
  const stateData = bytesToHex((chunks[8].data ?? []) as number[])

  const result: TokenOpReturnData = {
    tokenName,
    tokenRules,
    tokenAttributes,
    ownerPubKey,
    stateData,
  }

  // Optional on-chain bundle fields (chunks 9 and 10)
  if (chunks.length >= 11) {
    result.genesisTxId = bytesToHex((chunks[9].data ?? []) as number[])
    result.proofChainEntries = decodeProofChainBinary((chunks[10].data ?? []) as number[])
  }

  return result
}

// ─── Token Rules Encoding ───────────────────────────────────────────

/**
 * Encode token rules as an 8-byte hex string (4 x uint16 LE).
 *
 *   Bytes 0-1: supply (max units, 0 = unlimited)
 *   Bytes 2-3: divisibility (decimal places, 0 = NFT)
 *   Bytes 4-5: restrictions (bitfield, 0 = none)
 *   Bytes 6-7: version
 */
export function encodeTokenRules(
  supply: number,
  divisibility: number,
  restrictions: number,
  version: number,
): string {
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  view.setUint16(0, supply, true)
  view.setUint16(2, divisibility, true)
  view.setUint16(4, restrictions, true)
  view.setUint16(6, version, true)
  return bytesToHex(Array.from(new Uint8Array(buf)))
}

export function decodeTokenRules(rulesHex: string): {
  supply: number
  divisibility: number
  restrictions: number
  version: number
} {
  const bytes = hexToBytes(rulesHex)
  const view = new DataView(new Uint8Array(bytes).buffer)
  return {
    supply: view.getUint16(0, true),
    divisibility: view.getUint16(2, true),
    restrictions: view.getUint16(4, true),
    version: view.getUint16(6, true),
  }
}
