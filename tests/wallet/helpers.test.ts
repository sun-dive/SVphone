import {
    decodeTokenRules,
    verifyOwnership,
    verifyTokenId,
    serialiseBundle,
    parseBundle,
    tokenSummary,
} from '../../src/wallet/helpers'
import { encodeTokenRules } from '../../src/lib/genesis'
import { computeTokenId } from '../../src/lib/tokenId'
import { OwnedToken, TokenBundle } from '../../src/wallet/tokenManager'
import { ProofChain } from '../../src/lib/proofChain'

function makeToken(overrides: Partial<OwnedToken> = {}): OwnedToken {
    const genesisTxId = 'aa'.repeat(32)
    return {
        tokenId: computeTokenId(genesisTxId, 0),
        genesisTxId,
        genesisOutputIndex: 0,
        currentTxId: genesisTxId,
        currentOutputIndex: 0,
        tokenName: 'TestToken',
        tokenRules: encodeTokenRules(10, 0, 0, 1) as string,
        tokenAttributes: 'bb'.repeat(8),
        ownerPubKey: 'cc'.repeat(33),
        stateData: '',
        satoshis: 1,
        ...overrides,
    }
}

function makeProofChain(genesisTxId: string): ProofChain {
    return {
        genesisTxId,
        entries: [
            {
                txId: genesisTxId,
                blockHeight: 100,
                merkleRoot: 'dd'.repeat(32),
                path: [],
            },
        ],
    }
}

describe('decodeTokenRules', () => {
    it('should roundtrip with encodeTokenRules', () => {
        const encoded = encodeTokenRules(42, 8, 1, 3) as string
        const decoded = decodeTokenRules(encoded)

        expect(decoded.supply).toBe(42)
        expect(decoded.divisibility).toBe(8)
        expect(decoded.restrictions).toBe(1)
        expect(decoded.version).toBe(3)
    })

    it('should throw on invalid data', () => {
        expect(() => decodeTokenRules('aabb')).toThrow('Invalid token rules')
    })
})

describe('verifyOwnership', () => {
    it('should return true for matching pubkey', () => {
        const token = makeToken()
        expect(verifyOwnership(token, token.ownerPubKey)).toBe(true)
    })

    it('should return false for non-matching pubkey', () => {
        const token = makeToken()
        expect(verifyOwnership(token, 'ff'.repeat(33))).toBe(false)
    })
})

describe('verifyTokenId', () => {
    it('should return true for correctly derived token ID', () => {
        const token = makeToken()
        expect(verifyTokenId(token)).toBe(true)
    })

    it('should return false for tampered token ID', () => {
        const token = makeToken({ tokenId: 'ff'.repeat(32) })
        expect(verifyTokenId(token)).toBe(false)
    })
})

describe('serialiseBundle / parseBundle', () => {
    it('should roundtrip a token bundle', () => {
        const token = makeToken()
        const chain = makeProofChain(token.genesisTxId)
        const bundle: TokenBundle = { token, proofChain: chain }

        const json = serialiseBundle(bundle)
        const parsed = parseBundle(json)

        expect(parsed.token.tokenId).toBe(token.tokenId)
        expect(parsed.token.tokenName).toBe(token.tokenName)
        expect(parsed.proofChain.genesisTxId).toBe(chain.genesisTxId)
        expect(parsed.proofChain.entries).toHaveLength(1)
    })

    it('should throw on invalid JSON', () => {
        expect(() => parseBundle('{}')).toThrow('Invalid token bundle')
    })

    it('should throw on missing fields', () => {
        const bad = JSON.stringify({ token: { foo: 'bar' }, proofChain: { entries: [] } })
        expect(() => parseBundle(bad)).toThrow('missing required token fields')
    })
})

describe('tokenSummary', () => {
    it('should return a readable summary', () => {
        const token = makeToken()
        const summary = tokenSummary(token)

        expect(summary.tokenId).toBe(token.tokenId)
        expect(summary.name).toBe('TestToken')
        expect(summary.rules.supply).toBe(10)
        expect(summary.owner).toBe(token.ownerPubKey)
        expect(summary.currentUtxo).toBe(`${token.currentTxId}:0`)
    })
})
