/**
 * MPT Prototype Wallet v04 -- Browser entry point.
 *
 * v04 architecture:
 *   - Token protocol (tokenProtocol.ts) is pure SPV: Merkle proofs + block headers only
 *   - Wallet layer (walletProvider.ts) handles all network operations
 *   - Clean separation: verification works offline with pre-fetched headers
 *   - Ownership determined by P2PKH output, not OP_RETURN field
 *   - Address-based transfers (no public key exchange needed)
 */
import { PrivateKey } from '@bsv/sdk'
import { WalletProvider } from './walletProvider'
import { TokenBuilder } from './tokenBuilder'
import { TokenStore, LocalStorageBackend, OwnedToken } from './tokenStore'

// ─── Globals ────────────────────────────────────────────────────────

let provider: WalletProvider
let builder: TokenBuilder
let store: TokenStore

const WIF_KEY = 'mpt:wallet:wif'

// ─── Initialization ─────────────────────────────────────────────────

function init() {
  let wif = localStorage.getItem(WIF_KEY)
  let key: PrivateKey

  if (wif) {
    try {
      key = PrivateKey.fromWif(wif)
    } catch {
      key = PrivateKey.fromRandom()
      localStorage.setItem(WIF_KEY, key.toWif())
    }
  } else {
    key = PrivateKey.fromRandom()
    wif = key.toWif()
    localStorage.setItem(WIF_KEY, wif)
  }

  const address = key.toAddress()
  provider = new WalletProvider(address)
  const storage = new LocalStorageBackend('mpt:data:')
  store = new TokenStore(storage)
  builder = new TokenBuilder(provider, store, key)

  setText('address', address)
  setText('pubkey', key.toPublicKey().toString())
  setText('privkey', key.toWif())

  on('btn-refresh', refreshBalance)
  on('btn-send', handleSend)
  on('btn-mint', handleMint)
  on('btn-transfer', handleTransfer)
  on('btn-verify', handleVerify)
  on('btn-new-wallet', handleNewWallet)
  on('btn-restore-wallet', handleRestoreWallet)
  on('btn-check-incoming', handleCheckIncoming)

  refreshBalance()
  refreshTokenList()
  silentCheckIncoming()
  fetchMissingProofs()
}

// ─── Actions ────────────────────────────────────────────────────────

async function refreshBalance() {
  try {
    setText('balance', 'loading...')
    const bal = await provider.getBalance()
    setText('balance', `${bal} sats`)
  } catch (e: any) {
    setText('balance', `error: ${e.message}`)
  }
  silentCheckIncoming()
}

async function fetchMissingProofs() {
  try {
    const count = await builder.fetchMissingProofs()
    if (count > 0) {
      setText('incoming-status', `Updated ${count} proof chain(s)`)
      await refreshTokenList()
    }
  } catch {
    // Silent
  }
}

async function silentCheckIncoming() {
  try {
    const imported = await builder.checkIncomingTokens()
    if (imported.length > 0) {
      setText('incoming-status', `Auto-imported ${imported.length} token(s)`)
      await refreshTokenList()
    }
  } catch {
    // Silent
  }
}

async function refreshTokenList() {
  const tokens = (await store.listTokens()).sort((a, b) => {
    const da = a.createdAt ? new Date(a.createdAt).getTime() : 0
    const db = b.createdAt ? new Date(b.createdAt).getTime() : 0
    return db - da
  })
  const container = el('token-list')
  if (!container) return

  if (tokens.length === 0) {
    container.innerHTML = '<p class="muted">No tokens yet. Mint one above.</p>'
    return
  }

  container.innerHTML = tokens.map(t => {
    const statusBadge = renderStatusBadge(t.status)
    const actions = renderTokenActions(t)
    return `
    <div class="token-card ${t.status === 'transferred' ? 'token-transferred' : ''} ${t.status === 'pending_transfer' ? 'token-pending' : ''}">
      <div class="token-header">${escHtml(t.tokenName)} ${statusBadge}</div>
      <div class="token-field"><span class="label">Token ID:</span> <code class="selectable">${t.tokenId}</code></div>
      <div class="token-field"><span class="label">Current TXID:</span> <code class="selectable">${t.currentTxId}</code></div>
      <div class="token-field"><span class="label">Output:</span> ${t.currentOutputIndex}</div>
      <div class="token-field"><span class="label">Sats:</span> ${t.satoshis}</div>
      ${t.createdAt ? `<div class="token-field"><span class="label">Created:</span> ${formatDate(t.createdAt)}</div>` : ''}
      ${t.feePaid !== undefined ? `<div class="token-field"><span class="label">Fee:</span> ${t.feePaid} sats</div>` : ''}
      ${t.transferTxId ? `<div class="token-field"><span class="label">Transfer TXID:</span> <code class="selectable">${t.transferTxId}</code></div>` : ''}
      <div class="token-actions">${actions}</div>
    </div>
  `}).join('')
}

function renderStatusBadge(status: string): string {
  switch (status) {
    case 'active': return '<span class="badge badge-active">Active</span>'
    case 'pending_transfer': return '<span class="badge badge-pending">Pending Transfer</span>'
    case 'transferred': return '<span class="badge badge-transferred">Transferred</span>'
    default: return ''
  }
}

function renderTokenActions(t: OwnedToken): string {
  const parts: string[] = []

  if (t.status === 'active') {
    parts.push(`<button onclick="window._selectForTransfer('${t.tokenId}')">Select for Transfer</button>`)
    parts.push(`<button onclick="window._verifyToken('${t.tokenId}')">Verify</button>`)
  }

  if (t.status === 'pending_transfer') {
    parts.push(`<button onclick="window._confirmTransfer('${t.tokenId}')" class="btn-confirm">Confirm Sent</button>`)
  }

  if (t.currentTxId) {
    parts.push(`<a href="https://whatsonchain.com/tx/${t.currentTxId}" target="_blank" rel="noopener">View TX</a>`)
  }
  if (t.transferTxId && t.transferTxId !== t.currentTxId) {
    parts.push(`<a href="https://whatsonchain.com/tx/${t.transferTxId}" target="_blank" rel="noopener">View Transfer TX</a>`)
  }

  return parts.join('\n')
}

async function handleSend() {
  const address = inputVal('send-address')
  const amountStr = inputVal('send-amount')

  if (!address || !amountStr) {
    setResult('send-result', 'Enter both a recipient address and amount.')
    return
  }

  const amount = parseInt(amountStr, 10)
  if (!amount || amount < 1) {
    setResult('send-result', 'Amount must be at least 1 satoshi.')
    return
  }

  const feeRate = parseInt(inputVal('fee-rate'), 10)
  if (feeRate > 0) builder.feePerKb = feeRate

  setResult('send-result', 'Building transaction...')

  try {
    const result = await builder.sendSats(address, amount)
    setResult('send-result', [
      'Sent!',
      `TXID: ${result.txId}`,
      `Amount: ${amount} sats`,
      `Fee: ${result.fee} sats`,
      `View: https://whatsonchain.com/tx/${result.txId}`,
    ].join('\n'))
    await refreshBalance()
  } catch (e: any) {
    setResult('send-result', `Error: ${e.message}`)
  }
}

async function handleMint() {
  const name = inputVal('token-name')
  const attrs = inputVal('token-attrs') || '00'

  if (!name) {
    setResult('mint-result', 'Enter a token name.')
    return
  }

  const feeRate = parseInt(inputVal('fee-rate'), 10)
  if (feeRate > 0) builder.feePerKb = feeRate

  setResult('mint-result', 'Building genesis transaction...')

  try {
    const result = await builder.createGenesis({
      tokenName: name,
      attributes: attrs,
    })

    setResult('mint-result', [
      'Genesis broadcast!',
      `TXID: ${result.txId}`,
      `Token ID: ${result.tokenId}`,
      `View: https://whatsonchain.com/tx/${result.txId}`,
      '',
      'Polling for Merkle proof (may take ~10 min)...',
    ].join('\n'))

    await refreshTokenList()
    await refreshBalance()

    builder.pollForProof(result.tokenId, result.txId, (msg) => {
      setResult('mint-result', [
        `TXID: ${result.txId}`,
        `Token ID: ${result.tokenId}`,
        msg,
      ].join('\n'))
    }).then(found => {
      if (found) refreshTokenList()
    })

  } catch (e: any) {
    setResult('mint-result', `Error: ${e.message}`)
  }
}

async function handleTransfer() {
  const tokenId = inputVal('transfer-token-id')
  const recipient = inputVal('transfer-recipient')

  if (!tokenId || !recipient) {
    setResult('transfer-result', 'Enter both Token ID and recipient BSV address.')
    return
  }

  const feeRate = parseInt(inputVal('fee-rate'), 10)
  if (feeRate > 0) builder.feePerKb = feeRate

  setResult('transfer-result', 'Building transfer transaction...')

  try {
    const result = await builder.createTransfer(tokenId, recipient)

    setResult('transfer-result', [
      'Transfer broadcast!',
      `TXID: ${result.txId}`,
      `View: https://whatsonchain.com/tx/${result.txId}`,
      '',
      'Token data is encoded on-chain. The recipient can click',
      '"Check Incoming Tokens" to auto-import it.',
    ].join('\n'))

    await refreshTokenList()
    await refreshBalance()

  } catch (e: any) {
    setResult('transfer-result', `Error: ${e.message}`)
  }
}

async function handleVerify() {
  const tokenId = inputVal('verify-token-id')
  if (!tokenId) {
    setResult('verify-result', 'Enter a Token ID.')
    return
  }

  setResult('verify-result', 'Verifying...')

  try {
    const result = await builder.verifyToken(tokenId)
    setResult('verify-result', [
      `Valid: ${result.valid}`,
      `Reason: ${result.reason}`,
    ].join('\n'))
  } catch (e: any) {
    setResult('verify-result', `Error: ${e.message}`)
  }
}

async function handleCheckIncoming() {
  setText('incoming-status', 'Scanning blockchain...')
  try {
    const imported = await builder.checkIncomingTokens((msg) => {
      setText('incoming-status', msg)
    })
    if (imported.length > 0) {
      await refreshTokenList()
    }
  } catch (e: any) {
    setText('incoming-status', `Error: ${e.message}`)
  }
}

function handleNewWallet() {
  if (!confirm('This will generate a new key and clear all tokens. Continue?')) return
  localStorage.clear()
  location.reload()
}

function handleRestoreWallet() {
  const wif = inputVal('import-wif')
  if (!wif) {
    alert('Paste a WIF private key first.')
    return
  }

  try {
    const testKey = PrivateKey.fromWif(wif)
    testKey.toPublicKey()
  } catch {
    alert('Invalid WIF private key.')
    return
  }

  if (!confirm('This will replace the current wallet key and reload the page. Token data in storage will be preserved. Continue?')) return

  localStorage.setItem(WIF_KEY, wif)
  location.reload()
}

// ─── Window-exposed helpers for inline onclick handlers ─────────────

(window as any)._selectForTransfer = (tokenId: string) => {
  const input = el('transfer-token-id') as HTMLInputElement
  if (input) input.value = tokenId
}

;(window as any)._verifyToken = (tokenId: string) => {
  const input = el('verify-token-id') as HTMLInputElement
  if (input) input.value = tokenId
  handleVerify().then(() => {
    el('verify-result')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

;(window as any)._confirmTransfer = async (tokenId: string) => {
  if (!confirm('Mark this token as transferred?')) return
  try {
    await builder.confirmTransfer(tokenId)
    await refreshTokenList()
  } catch (e: any) {
    alert(`Error: ${e.message}`)
  }
}

// ─── DOM Helpers ────────────────────────────────────────────────────

function el(id: string): HTMLElement | null {
  return document.getElementById(id)
}

function setText(id: string, text: string) {
  const e = el(id)
  if (e) e.textContent = text
}

function setResult(id: string, text: string) {
  const e = el(id)
  if (e) e.textContent = text
}

function inputVal(id: string): string {
  const e = el(id) as HTMLInputElement | HTMLTextAreaElement | null
  return e?.value?.trim() ?? ''
}

function on(id: string, handler: () => void) {
  el(id)?.addEventListener('click', handler)
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}

// ─── Boot ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init)
