What the two-transaction design gives you:

Self-referential Token ID. The Token ID is derived from the genesis TXID, which doesn't exist until the first transaction is mined. A single-TX design can't include its own TXID in its data — you'd need an external identifier or a pre-commitment scheme instead.

Embedded proof of mining. The Merkle Proof Genesis Hash proves the genesis TX was included in a block. This anchors the proof chain to a confirmed block rather than an unconfirmed transaction. Wallet B can verify the token was mined without querying a node.

Clean separation of intent and confirmation. Genesis says "this token exists." Finalisation says "and here's the cryptographic proof it was confirmed." The token isn't considered valid until both are done.

What a single-transaction design would give you instead:

Simpler flow. One TX, one fee, done. No waiting for confirmation between steps.
Lower cost. One transaction fee instead of two.
No window of invalidity. In the two-TX model, between genesis and finalisation the token UTXO exists but has a null genesis hash — it's in a liminal state. A single-TX design is valid immediately.
The core question is whether you need the Token ID to be self-derived from the genesis TXID. If you used an alternative ID scheme — say a hash of Token Name + Owner pubkey + a nonce — you could do everything in one transaction. The tradeoff is that the ID would be less canonical (relies on the creator choosing a unique nonce) and not intrinsically tied to the chain.

The two-TX design is stronger for trustless verification because every piece of the token's identity is anchored to on-chain facts. But if your use case has a trusted issuer or an off-chain registry, the single-TX approach may be sufficient and more practical.