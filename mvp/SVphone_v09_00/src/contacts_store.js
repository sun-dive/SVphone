/**
 * Contacts Store — maps BSV addresses to DTLS fingerprints (localStorage).
 *
 * Contact identity string (share out-of-band — paste in Signal, QR code, etc.):
 *   "<bsvAddress>:sha-256:<COLON-SEPARATED-HEX>"
 * Example:
 *   "1AaBbCcDd...:sha-256:AB:CD:EF:01:23:45:..."
 *
 * Internal storage key: 'svphone_contact_<bsvAddress>'
 * Internal storage val: 'sha-256 AB:CD:...' (space after algorithm, per WebRTC spec)
 */
class ContactsStore {
  static PREFIX = 'svphone_contact_'

  /**
   * Parse a contact identity string into { address, fingerprint }.
   * Format: "ADDRESS:sha-256:XX:XX:..."
   * @returns {{ address: string, fingerprint: string } | null}
   */
  parse(identityStr) {
    if (!identityStr) return null
    const idx = identityStr.toLowerCase().indexOf(':sha-256:')
    if (idx === -1) return null
    const address     = identityStr.slice(0, idx).trim()
    const fpColons    = identityStr.slice(idx + 9).trim().toUpperCase()
    if (!address || fpColons.length < 5) return null
    return { address, fingerprint: 'sha-256 ' + fpColons }
  }

  /**
   * Format an identity string from address + fingerprint.
   * @param {string} address    - BSV address
   * @param {string} fingerprint - "sha-256 AB:CD:EF:..."
   * @returns {string}
   */
  format(address, fingerprint) {
    if (!address || !fingerprint) return ''
    const colonFp = fingerprint.replace(/^sha-256\s+/i, '')
    return `${address}:sha-256:${colonFp}`
  }

  /** Save a contact */
  save(address, fingerprint) {
    if (!address || !fingerprint) return
    localStorage.setItem(ContactsStore.PREFIX + address, fingerprint)
  }

  /** Look up fingerprint by address, or null */
  get(address) {
    return localStorage.getItem(ContactsStore.PREFIX + address) ?? null
  }

  /** Return all contacts as [{address, fingerprint}] */
  getAll() {
    const out = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(ContactsStore.PREFIX)) {
        const address     = key.slice(ContactsStore.PREFIX.length)
        const fingerprint = localStorage.getItem(key)
        out.push({ address, fingerprint })
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
