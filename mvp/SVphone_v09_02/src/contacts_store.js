/**
 * Contacts Store — maps BSV addresses to DTLS fingerprints + public IPs (localStorage).
 *
 * Contact identity string (share out-of-band — paste in Signal, QR code, etc.):
 *   "<bsvAddress>:sha-256:<COLON-SEPARATED-HEX>@<publicIP>"
 * Examples:
 *   "1AaBbCcDd...:sha-256:AB:CD:EF:01:23:45:...@203.0.113.42"
 *   "1AaBbCcDd...:sha-256:AB:CD:EF:01:23:45:..."          (no IP — backward compat)
 *
 * Internal storage key: 'svphone_contact_<bsvAddress>'
 * Internal storage val: JSON {"fingerprint":"sha-256 AB:CD:...","ip":"203.0.113.42"}
 *   (backward-compat: old plain string "sha-256 AB:CD:..." is read as {fingerprint, ip:null})
 */
class ContactsStore {
  static PREFIX = 'svphone_contact_'

  /**
   * Parse a contact identity string into { address, fingerprint, ip }.
   * Format: "ADDRESS:sha-256:XX:XX:...[@IP]"
   * @returns {{ address: string, fingerprint: string, ip: string|null } | null}
   */
  parse(identityStr) {
    if (!identityStr) return null
    const idx = identityStr.toLowerCase().indexOf(':sha-256:')
    if (idx === -1) return null
    const address = identityStr.slice(0, idx).trim()
    let tail = identityStr.slice(idx + 9).trim()
    if (!address || tail.length < 5) return null

    // Split fingerprint from optional IP at last '@'
    let ip = null
    const atIdx = tail.lastIndexOf('@')
    if (atIdx !== -1) {
      ip = tail.slice(atIdx + 1).trim() || null
      tail = tail.slice(0, atIdx).trim()
    }
    const fpColons = tail.toUpperCase()
    return { address, fingerprint: 'sha-256 ' + fpColons, ip }
  }

  /**
   * Format an identity string from address + fingerprint + optional IP.
   * @param {string} address     - BSV address
   * @param {string} fingerprint - "sha-256 AB:CD:EF:..."
   * @param {string|null} ip     - public IP (optional)
   * @returns {string}
   */
  format(address, fingerprint, ip = null) {
    if (!address || !fingerprint) return ''
    const colonFp = fingerprint.replace(/^sha-256\s+/i, '')
    let str = `${address}:sha-256:${colonFp}`
    if (ip) str += `@${ip}`
    return str
  }

  /** Save a contact (fingerprint + optional IP) */
  save(address, fingerprint, ip = null) {
    if (!address || !fingerprint) return
    localStorage.setItem(ContactsStore.PREFIX + address, JSON.stringify({ fingerprint, ip: ip || null }))
  }

  /** Look up contact by address → { fingerprint, ip } or null */
  get(address) {
    const raw = localStorage.getItem(ContactsStore.PREFIX + address)
    if (!raw) return null
    // JSON format (new)
    if (raw.startsWith('{')) {
      try { return JSON.parse(raw) } catch { /* fall through */ }
    }
    // Plain fingerprint string (old backward-compat)
    return { fingerprint: raw, ip: null }
  }

  /** Return all contacts as [{ address, fingerprint, ip }] */
  getAll() {
    const out = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(ContactsStore.PREFIX)) {
        const address = key.slice(ContactsStore.PREFIX.length)
        const raw = localStorage.getItem(key)
        if (raw?.startsWith('{')) {
          try {
            const { fingerprint, ip } = JSON.parse(raw)
            out.push({ address, fingerprint, ip: ip || null })
            continue
          } catch { /* fall through */ }
        }
        out.push({ address, fingerprint: raw, ip: null })
      }
    }
    return out
  }

  /** Remove a contact */
  remove(address) {
    localStorage.removeItem(ContactsStore.PREFIX + address)
  }
}

if (typeof window !== 'undefined') window.ContactsStore = ContactsStore
if (typeof module !== 'undefined' && module.exports) module.exports = ContactsStore
