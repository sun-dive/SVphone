/**
 * DTLS Certificate Store — Persistent RTCCertificate via IndexedDB
 *
 * Generates one DTLS certificate per device and persists it so the
 * fingerprint stays stable across sessions (enabling 1-TX call signaling).
 * The stable fingerprint is the device's call identity — share it once
 * with each contact (as part of your identity string) and skip the ANS token.
 */
class DtlsCertStore {
  static DB_NAME    = 'svphone_dtls'
  static STORE_NAME = 'certs'
  static KEY        = 'primary'

  /**
   * Return the persisted certificate, generating one if not yet stored.
   * @returns {Promise<RTCCertificate>}
   */
  async getOrCreate() {
    const existing = await this._load()
    if (existing) return existing

    const cert = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
    })
    await this._save(cert)
    return cert
  }

  /**
   * Extract the SHA-256 fingerprint string from a certificate.
   * @param {RTCCertificate} cert
   * @returns {string} e.g. "sha-256 AB:CD:EF:..."
   */
  getFingerprint(cert) {
    const fps    = cert.getFingerprints()
    const sha256 = fps.find(f => f.algorithm.toLowerCase() === 'sha-256') || fps[0]
    if (!sha256) throw new Error('[DtlsCertStore] No fingerprint in certificate')
    return `sha-256 ${sha256.value.toUpperCase()}`
  }

  async _load() {
    const db = await this._openDb()
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(DtlsCertStore.STORE_NAME, 'readonly')
      const req = tx.objectStore(DtlsCertStore.STORE_NAME).get(DtlsCertStore.KEY)
      req.onsuccess = () => { db.close(); resolve(req.result?.cert ?? null) }
      req.onerror   = () => { db.close(); reject(req.error) }
    })
  }

  async _save(cert) {
    const db = await this._openDb()
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(DtlsCertStore.STORE_NAME, 'readwrite')
      const req = tx.objectStore(DtlsCertStore.STORE_NAME).put({ cert }, DtlsCertStore.KEY)
      req.onsuccess = () => { db.close(); resolve() }
      req.onerror   = () => { db.close(); reject(req.error) }
    })
  }

  _openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DtlsCertStore.DB_NAME, 1)
      req.onupgradeneeded = (e) => {
        e.target.result.createObjectStore(DtlsCertStore.STORE_NAME)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror   = () => reject(req.error)
    })
  }
}

if (typeof window !== 'undefined') window.DtlsCertStore = DtlsCertStore
if (typeof module !== 'undefined' && module.exports) module.exports = DtlsCertStore
