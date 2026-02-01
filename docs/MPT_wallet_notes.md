Pure SPV token protocol -- verification needs only Merkle proofs + block headers, no network
Clean layer separation -- token protocol never imports from wallet layer
Blanket 1-sat UTXO quarantine -- protects MPT tokens, Ordinals, and any unknown token type from accidental spending
Auto-import -- incoming tokens detected and imported from on-chain data


All UTXOs with value <= 1 sat are permanently quarantined. They are never used as funding inputs, regardless of whether they're MPT, Ordinals, or anything else. The only way a 1-sat UTXO gets spent is through createTransfer(), where the user explicitly selects a known token to transfer.

The auto-import logic still runs in the background on quarantined UTXOs so MPT tokens get detected, but the quarantine applies even if the check fails or the UTXO turns out to be a non-MPT token type. No cleared list needed -- there's nothing to clear.

