import { ProofStore, MemoryStorage } from '../../src/wallet/proofStore'
import { ProofChain } from '../../src/lib/proofChain'

function makeChain(genesisTxId: string): ProofChain {
    return {
        genesisTxId,
        entries: [
            {
                txId: genesisTxId,
                blockHeight: 100,
                merkleRoot: 'aa'.repeat(32),
                path: [],
            },
        ],
    }
}

describe('MemoryStorage', () => {
    it('should store and retrieve values', async () => {
        const storage = new MemoryStorage()
        await storage.set('key1', 'value1')
        expect(await storage.get('key1')).toBe('value1')
    })

    it('should return null for missing keys', async () => {
        const storage = new MemoryStorage()
        expect(await storage.get('missing')).toBeNull()
    })

    it('should delete values', async () => {
        const storage = new MemoryStorage()
        await storage.set('key1', 'value1')
        await storage.delete('key1')
        expect(await storage.get('key1')).toBeNull()
    })

    it('should list keys', async () => {
        const storage = new MemoryStorage()
        await storage.set('a', '1')
        await storage.set('b', '2')
        const keys = await storage.keys()
        expect(keys.sort()).toEqual(['a', 'b'])
    })
})

describe('ProofStore', () => {
    let store: ProofStore

    beforeEach(() => {
        store = new ProofStore(new MemoryStorage())
    })

    it('should save and load a proof chain', async () => {
        const chain = makeChain('aa'.repeat(32))
        await store.save('token1', chain)

        const loaded = await store.load('token1')
        expect(loaded).not.toBeNull()
        expect(loaded!.genesisTxId).toBe('aa'.repeat(32))
        expect(loaded!.entries).toHaveLength(1)
    })

    it('should return null for missing token', async () => {
        expect(await store.load('missing')).toBeNull()
    })

    it('should delete a proof chain', async () => {
        const chain = makeChain('bb'.repeat(32))
        await store.save('token2', chain)
        await store.delete('token2')
        expect(await store.load('token2')).toBeNull()
    })

    it('should list stored token IDs', async () => {
        await store.save('tokenA', makeChain('aa'.repeat(32)))
        await store.save('tokenB', makeChain('bb'.repeat(32)))

        const ids = await store.listTokenIds()
        expect(ids.sort()).toEqual(['tokenA', 'tokenB'])
    })
})
