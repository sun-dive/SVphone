import { TokenManager, OwnedToken } from '../../src/wallet/tokenManager'
import { MemoryStorage } from '../../src/wallet/proofStore'
import { ProofChain } from '../../src/lib/proofChain'
import { computeTokenId } from '../../src/lib/tokenId'
import { encodeTokenRules } from '../../src/lib/genesis'

function makeToken(index: number = 0): { token: OwnedToken; chain: ProofChain } {
    const genesisTxId = 'ab'.repeat(32)
    const tokenId = computeTokenId(genesisTxId, index)

    const token: OwnedToken = {
        tokenId,
        genesisTxId,
        genesisOutputIndex: index,
        currentTxId: genesisTxId,
        currentOutputIndex: index,
        tokenName: 'TestNFT',
        tokenRules: encodeTokenRules(5, 0, 0, 1) as string,
        tokenAttributes: `0${index}`.repeat(8),
        ownerPubKey: 'cc'.repeat(33),
        stateData: '',
        satoshis: 1,
    }

    const chain: ProofChain = {
        genesisTxId,
        entries: [
            {
                txId: genesisTxId,
                blockHeight: 200,
                merkleRoot: 'dd'.repeat(32),
                path: [],
            },
        ],
    }

    return { token, chain }
}

describe('TokenManager', () => {
    let manager: TokenManager

    beforeEach(() => {
        manager = new TokenManager(new MemoryStorage())
    })

    it('should add and retrieve a token', async () => {
        const { token, chain } = makeToken()
        await manager.addToken(token, chain)

        const loaded = await manager.getToken(token.tokenId)
        expect(loaded).not.toBeNull()
        expect(loaded!.tokenName).toBe('TestNFT')
        expect(loaded!.tokenId).toBe(token.tokenId)
    })

    it('should return null for unknown token', async () => {
        expect(await manager.getToken('nonexistent')).toBeNull()
    })

    it('should list all tokens', async () => {
        const t0 = makeToken(0)
        const t1 = makeToken(1)
        await manager.addToken(t0.token, t0.chain)
        await manager.addToken(t1.token, t1.chain)

        const tokens = await manager.listTokens()
        expect(tokens).toHaveLength(2)

        const ids = tokens.map((t) => t.tokenId).sort()
        expect(ids).toContain(t0.token.tokenId)
        expect(ids).toContain(t1.token.tokenId)
    })

    it('should remove a token and its proof chain', async () => {
        const { token, chain } = makeToken()
        await manager.addToken(token, chain)
        await manager.removeToken(token.tokenId)

        expect(await manager.getToken(token.tokenId)).toBeNull()
        expect(await manager.getProofChain(token.tokenId)).toBeNull()
    })

    it('should retrieve proof chain for a token', async () => {
        const { token, chain } = makeToken()
        await manager.addToken(token, chain)

        const loaded = await manager.getProofChain(token.tokenId)
        expect(loaded).not.toBeNull()
        expect(loaded!.genesisTxId).toBe(token.genesisTxId)
    })

    it('should update token UTXO location', async () => {
        const { token, chain } = makeToken()
        await manager.addToken(token, chain)

        const newTxId = 'ee'.repeat(32)
        await manager.updateTokenUtxo(
            token.tokenId,
            newTxId,
            0,
            'ff'.repeat(33),
            'deadbeef'
        )

        const updated = await manager.getToken(token.tokenId)
        expect(updated!.currentTxId).toBe(newTxId)
        expect(updated!.ownerPubKey).toBe('ff'.repeat(33))
        expect(updated!.stateData).toBe('deadbeef')
    })

    it('should throw when updating non-existent token', async () => {
        await expect(
            manager.updateTokenUtxo('missing', 'aa'.repeat(32), 0, '', '')
        ).rejects.toThrow('Token not found')
    })

    it('should export a token bundle', async () => {
        const { token, chain } = makeToken()
        await manager.addToken(token, chain)

        const bundle = await manager.exportToken(token.tokenId)
        expect(bundle.token.tokenId).toBe(token.tokenId)
        expect(bundle.proofChain.genesisTxId).toBe(token.genesisTxId)
    })

    it('should throw when exporting non-existent token', async () => {
        await expect(manager.exportToken('missing')).rejects.toThrow(
            'Token not found'
        )
    })

    it('should import a token bundle', async () => {
        const { token, chain } = makeToken()
        const bundle = { token, proofChain: chain }

        await manager.importToken(bundle)

        const loaded = await manager.getToken(token.tokenId)
        expect(loaded).not.toBeNull()
        expect(loaded!.tokenId).toBe(token.tokenId)
    })
})
