import { ByteString } from 'scrypt-ts'
import { OwnedToken, TokenBundle } from './tokenManager'
import { ProofChain } from '../lib/proofChain'
import { computeTokenId } from '../lib/tokenId'

/** Decoded token rules. */
export interface DecodedTokenRules {
    /** Total NFT count in genesis TX. */
    supply: number
    /** Decimal places (0 for NFTs). */
    divisibility: number
    /** 0 = unrestricted, 1 = whitelist, 2 = time-lock. */
    restrictions: number
    /** Rules version. */
    version: number
}

/**
 * Decode a hex-encoded token rules ByteString into structured data.
 * Reverse of encodeTokenRules().
 */
export function decodeTokenRules(tokenRules: string): DecodedTokenRules {
    const buf = Buffer.from(tokenRules, 'hex')
    if (buf.length < 8) {
        throw new Error(`Invalid token rules: expected 8 bytes, got ${buf.length}`)
    }
    return {
        supply: buf.readUInt32LE(0),
        divisibility: buf.readUInt8(4),
        restrictions: buf.readUInt8(5),
        version: buf.readUInt16LE(6),
    }
}

/**
 * Check if a public key is the current owner of a token.
 */
export function verifyOwnership(token: OwnedToken, pubKey: string): boolean {
    return token.ownerPubKey === pubKey
}

/**
 * Verify that a Token ID is correctly derived from its genesis TXID.
 */
export function verifyTokenId(token: OwnedToken): boolean {
    const expected = computeTokenId(
        token.genesisTxId,
        token.genesisOutputIndex
    )
    return expected === token.tokenId
}

/**
 * Build a self-contained token bundle for peer-to-peer transfer.
 * The bundle contains everything the recipient needs to verify
 * and claim the token.
 */
export function buildTokenBundle(
    token: OwnedToken,
    proofChain: ProofChain
): TokenBundle {
    return { token, proofChain }
}

/**
 * Serialise a token bundle to a JSON string.
 * Can be transmitted via any channel: file, QR code, NFC, etc.
 */
export function serialiseBundle(bundle: TokenBundle): string {
    return JSON.stringify(bundle)
}

/**
 * Parse a token bundle from a JSON string.
 */
export function parseBundle(data: string): TokenBundle {
    const parsed = JSON.parse(data)

    if (!parsed.token || !parsed.proofChain) {
        throw new Error('Invalid token bundle: missing token or proofChain')
    }

    if (!parsed.token.tokenId || !parsed.token.genesisTxId) {
        throw new Error('Invalid token bundle: missing required token fields')
    }

    if (!Array.isArray(parsed.proofChain.entries)) {
        throw new Error('Invalid token bundle: proofChain.entries must be an array')
    }

    return parsed as TokenBundle
}

/**
 * Get a human-readable summary of a token.
 */
export function tokenSummary(token: OwnedToken): {
    tokenId: string
    name: string
    rules: DecodedTokenRules
    owner: string
    currentUtxo: string
} {
    return {
        tokenId: token.tokenId,
        name: token.tokenName,
        rules: decodeTokenRules(token.tokenRules),
        owner: token.ownerPubKey,
        currentUtxo: `${token.currentTxId}:${token.currentOutputIndex}`,
    }
}
