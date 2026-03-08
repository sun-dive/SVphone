/**
 * ICE Credential Derivation — deterministic ICE ufrag/pwd via HMAC-SHA256.
 *
 * Both caller and callee derive the same ICE credentials from the shared
 * session key, so the caller can build a synthetic callee answer SDP (with
 * callee's credentials pre-filled) without waiting for an ANS token.
 *
 * Derivation:
 *   callerUfrag = base64url( HMAC-SHA256(sessionKey, "caller:ufrag") ).slice(0, 8)
 *   callerPwd   = base64url( HMAC-SHA256(sessionKey, "caller:pwd")  ).slice(0, 22)
 *   calleeUfrag = base64url( HMAC-SHA256(sessionKey, "callee:ufrag") ).slice(0, 8)
 *   calleePwd   = base64url( HMAC-SHA256(sessionKey, "callee:pwd")  ).slice(0, 22)
 *
 * ICE spec: ufrag 4-256 chars, pwd 22-256 chars (all base64url-safe).
 */
class IceCredentials {
  /**
   * Derive all four ICE credentials from a shared session key.
   * @param {string} sessionKey - base64 session key (from call token)
   * @returns {Promise<{callerUfrag, callerPwd, calleeUfrag, calleePwd}>}
   */
  async deriveAll(sessionKey) {
    const keyBytes  = this._base64ToBytes(sessionKey)
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const [cu, cp, eu, ep] = await Promise.all([
      this._hmac(cryptoKey, 'caller:ufrag'),
      this._hmac(cryptoKey, 'caller:pwd'),
      this._hmac(cryptoKey, 'callee:ufrag'),
      this._hmac(cryptoKey, 'callee:pwd'),
    ])
    return {
      callerUfrag: this._toBase64url(cu).slice(0, 8),
      callerPwd:   this._toBase64url(cp).slice(0, 22),
      calleeUfrag: this._toBase64url(eu).slice(0, 8),
      calleePwd:   this._toBase64url(ep).slice(0, 22),
    }
  }

  /**
   * Replace a=ice-ufrag and a=ice-pwd lines in an SDP string.
   * Call this BEFORE setLocalDescription to use derived credentials.
   * @param {string} sdp
   * @param {string} ufrag
   * @param {string} pwd
   * @returns {string} munged SDP
   */
  mungeSdp(sdp, ufrag, pwd) {
    return sdp
      .split(/\r?\n/)
      .map(line => {
        if (line.startsWith('a=ice-ufrag:')) return `a=ice-ufrag:${ufrag}`
        if (line.startsWith('a=ice-pwd:'))   return `a=ice-pwd:${pwd}`
        return line
      })
      .join('\r\n')
  }

  async _hmac(cryptoKey, label) {
    const data = new TextEncoder().encode(label)
    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, data))
  }

  _base64ToBytes(b64) {
    const std = b64.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(std)
    return new Uint8Array(bin.length).map((_, i) => bin.charCodeAt(i))
  }

  _toBase64url(bytes) {
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  }
}

if (typeof window !== 'undefined') window.IceCredentials = IceCredentials
if (typeof module !== 'undefined' && module.exports) module.exports = IceCredentials
