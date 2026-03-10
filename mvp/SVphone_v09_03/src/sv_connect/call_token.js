/**
 * Call Token Manager (v09.03) - P Protocol Conformant Signal Tokens
 *
 * Signal tokens (CALL, ANS) use the standard P v03 OP_RETURN format
 * with proper field separation:
 *
 *   tokenName:       "CALL-v1" | "ANS-v1"
 *   tokenScript:     "" (empty, P2PKH fallback)
 *   tokenRules:      4-byte format (supply=1, divisibility=0)
 *   tokenAttributes: Compact connection metadata (IP, port, session key, codec, addresses, fingerprint)
 *   stateData:       SDP offer/answer (the large payload)
 *
 * TX structure:
 *   Output 0: OP_RETURN (0 sats) — P v03 format
 *   Output 1: P2PKH 1-sat → recipient (WoC address history indexing)
 *   Output 2: P2PKH change → sender
 */

const CODECS = { opus: 0, pcm: 1, aac: 2 }
const CODEC_IDS = ['opus', 'pcm', 'aac']
const QUALITIES = { sd: 0, hd: 1, vhd: 2 }
const QUALITY_IDS = ['sd', 'hd', 'vhd']

class CallTokenManager {
  constructor(uiLogger) {
    this.log = uiLogger
  }

  /**
   * Encode connection metadata into tokenAttributes (no SDP — that goes in stateData).
   * @param {Object} callToken - {senderIp, senderPort, sessionKey, codec, quality, caller, callee, callerFingerprint}
   * @returns {string} Hex-encoded binary
   */
  encodeCallAttributes(callToken) {
    try {
      const bytes = []

      // Version marker (0x03 = binary sessionKey, saves 12 bytes over base64)
      bytes.push(0x03)

      // IP address: 1 byte type (0=IPv4, 1=IPv6) + 4 or 16 bytes
      const ip = callToken.senderIp || '0.0.0.0'
      const port = callToken.senderPort
      const isIPv6 = ip.includes(':')

      if (!isIPv6) {
        bytes.push(0x00)
        bytes.push(...ip.split('.').map(p => parseInt(p, 10)))
      } else {
        bytes.push(0x01)
        bytes.push(...this._ipv6ToBytes(ip))
      }

      // Port (2 bytes, big-endian)
      bytes.push((port >> 8) & 0xFF)
      bytes.push(port & 0xFF)

      // Session key (1-byte length prefix + raw binary bytes)
      // Base64 string → raw bytes (32 bytes instead of 44-char base64 string)
      const keyB64 = callToken.sessionKey || ''
      const keyBin = atob(keyB64)
      const keyBuf = new Uint8Array(keyBin.length)
      for (let i = 0; i < keyBin.length; i++) keyBuf[i] = keyBin.charCodeAt(i)
      bytes.push(keyBuf.length)
      bytes.push(...keyBuf)

      // Codec (1 byte enum)
      bytes.push(CODECS[callToken.codec] ?? 0)

      // Quality (1 byte enum)
      bytes.push(QUALITIES[callToken.quality] ?? 1)

      // Caller address (1-byte length prefix + N bytes UTF-8)
      const callerBuf = new TextEncoder().encode(callToken.caller || '')
      bytes.push(callerBuf.length)
      bytes.push(...callerBuf)

      // Callee address (1-byte length prefix + N bytes UTF-8)
      const calleeBuf = new TextEncoder().encode(callToken.callee || '')
      bytes.push(calleeBuf.length)
      bytes.push(...calleeBuf)

      // callerFingerprint (1-byte length + N bytes UTF-8)
      const fpBuf = new TextEncoder().encode(callToken.callerFingerprint || '')
      bytes.push(fpBuf.length)
      bytes.push(...fpBuf)

      return bytes.map(b => ('0' + b.toString(16)).slice(-2)).join('')
    } catch (error) {
      console.error('[CallToken] Failed to encode attributes:', error)
      return '00'
    }
  }

  /**
   * Encode SDP into stateData hex string.
   * @param {Object} callToken - {sdpOffer|sdpAnswer}
   * @returns {string} Hex-encoded SDP string, or '00' if empty
   */
  encodeStateData(callToken) {
    let sdpData = callToken.sdpOffer || callToken.sdpAnswer || ''
    if (sdpData && typeof sdpData === 'object') sdpData = sdpData.sdp || ''
    if (!sdpData) return '00'
    // Strip ICE candidates — callee gets IP:port from tokenAttributes instead
    sdpData = sdpData.split(/\r?\n/).filter(l => !l.startsWith('a=candidate:')).join('\r\n')
    const sdpBuf = new TextEncoder().encode(sdpData)
    const hex = Array.from(sdpBuf).map(b => ('0' + b.toString(16)).slice(-2)).join('')
    // Self-test: decode immediately and verify round-trip
    const rt = this.decodeStateData(hex)
    if (rt !== sdpData) {
      console.error('[CallToken] ❌ SDP round-trip MISMATCH! encoded:', sdpData.length, 'decoded:', rt.length)
    } else {
      console.log(`[CallToken] ✓ SDP round-trip OK (${sdpData.length} chars, ${hex.length/2} bytes)`)
    }
    return hex
  }

  /**
   * Decode stateData hex string back to SDP string.
   * @param {string} stateHex - Hex-encoded stateData from OP_RETURN
   * @returns {string} SDP string, or '' if empty
   */
  decodeStateData(stateHex) {
    if (!stateHex || stateHex === '00' || stateHex === '') return ''
    const bytes = []
    for (let i = 0; i < stateHex.length; i += 2) {
      bytes.push(parseInt(stateHex.substring(i, i + 2), 16))
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }

  /**
   * Build 4-byte tokenRules for signal tokens.
   * Format: supply(2) + divisibility(2), uint16 LE.
   * @returns {string} 8-char hex string (4 bytes)
   */
  encodeSignalRules() {
    const supply = 1
    const divisibility = 0
    const buf = new Uint8Array(4)
    buf[0] = supply & 0xFF;       buf[1] = (supply >> 8) & 0xFF
    buf[2] = divisibility & 0xFF; buf[3] = (divisibility >> 8) & 0xFF
    return Array.from(buf).map(b => ('0' + b.toString(16)).slice(-2)).join('')
  }

  /**
   * Decode connection metadata from tokenAttributes (no SDP — that's in stateData).
   * @param {string} hexStr - Hex-encoded binary tokenAttributes
   * @returns {Object|null} {senderIp, senderPort, sessionKey, codec, quality, caller, callee, callerFingerprint}
   */
  decodeCallAttributes(hexStr) {
    if (!hexStr || hexStr === '00') return null
    try {
      const bytes = []
      for (let i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substring(i, i + 2), 16))
      }
      if (bytes.length < 10) return null

      let offset = 1 // Skip version byte

      // IP address: 1 byte type (0=IPv4, 1=IPv6) + 4 or 16 bytes
      const ipType = bytes[offset++]
      const isIPv6 = ipType === 0x01
      let senderIp
      if (!isIPv6) {
        senderIp = `${bytes[offset]}.${bytes[offset+1]}.${bytes[offset+2]}.${bytes[offset+3]}`
        offset += 4
      } else {
        senderIp = this._bytesToIPv6(bytes.slice(offset, offset + 16))
        offset += 16
      }

      // Port
      const senderPort = (bytes[offset] << 8) | bytes[offset + 1]
      offset += 2

      // Session key (raw binary bytes → base64 string)
      const keyLen = bytes[offset++]
      const keyBuf = bytes.slice(offset, offset + keyLen)
      const sessionKey = btoa(String.fromCharCode(...keyBuf))
      offset += keyLen

      // Codec and Quality
      const codec = CODEC_IDS[bytes[offset++]] || 'opus'
      const quality = QUALITY_IDS[bytes[offset++]] || 'hd'

      // Caller address
      let caller = ''
      if (offset < bytes.length) {
        const callerLen = bytes[offset++]
        const callerBuf = bytes.slice(offset, offset + callerLen)
        caller = new TextDecoder().decode(new Uint8Array(callerBuf))
        offset += callerLen
      }

      // Callee address
      let callee = ''
      if (offset < bytes.length) {
        const calleeLen = bytes[offset++]
        const calleeBuf = bytes.slice(offset, offset + calleeLen)
        callee = new TextDecoder().decode(new Uint8Array(calleeBuf))
        offset += calleeLen
      }

      // callerFingerprint (1-byte length + N bytes UTF-8)
      let callerFingerprint = null
      if (offset < bytes.length) {
        const fpLen = bytes[offset++]
        if (fpLen > 0 && offset + fpLen <= bytes.length) {
          const fpBuf = bytes.slice(offset, offset + fpLen)
          callerFingerprint = new TextDecoder().decode(new Uint8Array(fpBuf))
          offset += fpLen
        }
      }

      return { senderIp, senderPort, sessionKey, codec, quality, caller, callee, callerFingerprint }
    } catch (error) {
      console.error('[CallToken] Failed to decode attributes:', error)
      return null
    }
  }

  /** @private Convert IPv6 string to 16-byte array */
  _ipv6ToBytes(ip) {
    const parts = ip.split(':').filter(p => p.length > 0)
    const bytes = new Uint8Array(16)
    let byteIndex = 0
    for (let i = 0; i < parts.length && byteIndex < 16; i++) {
      const val = parseInt(parts[i], 16) || 0
      bytes[byteIndex++] = (val >> 8) & 0xFF
      bytes[byteIndex++] = val & 0xFF
    }
    return Array.from(bytes)
  }

  /** @private Convert 16-byte array to IPv6 string */
  _bytesToIPv6(bytes) {
    const parts = []
    for (let i = 0; i < 16; i += 2) {
      parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
    }
    return parts.join(':')
  }

  /**
   * Create and broadcast a CALL signal to the callee.
   * Single TX: OP_RETURN (call data) + 1-sat to callee + change.
   * @param {Object} callToken - {caller, callee, senderIp, senderPort, sessionKey, codec, quality, sdpOffer}
   * @returns {Promise<{txId: string}>}
   */
  async createAndBroadcastCallToken(callToken) {
    this.log(`Sending call signal to ${callToken.callee}`, 'info')
    try {
      const prefix = callToken.tokenPrefix || 'CALL'
      const tokenName = `${prefix}-v1`
      const rules = this.encodeSignalRules()
      const attrs = this.encodeCallAttributes(callToken)
      const stateData = this.encodeStateData(callToken)

      const feePerKb = callToken.feePerKb || 1.1
      const result = await window.tokenBuilder.createCallSignalTx(
        tokenName,
        rules,
        attrs,
        callToken.callee,
        feePerKb,
        stateData,
      )

      this.log(`✓ Call signal sent: ${result.txId}`, 'success')
      this.log(`https://whatsonchain.com/tx/${result.txId}`, 'info')

      return { txId: result.txId, tokenId: result.txId }
    } catch (err) {
      this.log(`Call signal failed: ${err.message}`, 'error')
      throw err
    }
  }

  /**
   * Broadcast an ANS signal back to the caller.
   * Same TX structure as CALL but with ANS- prefix.
   * The callerFingerprint field carries the callee's fingerprint in this direction.
   * @param {string} callerAddress - Caller's BSV address (recipient)
   * @param {Object} answerData - {callee, senderIp, senderPort, sessionKey, codec, quality, sdpAnswer, calleeFingerprint}
   * @returns {Promise<{txId: string}>}
   */
  async broadcastCallAnswer(callerAddress, answerData) {
    this.log('Sending answer signal to caller...', 'info')
    try {
      const ansToken = {
        senderIp:    answerData.senderIp || '0.0.0.0',
        senderPort:  answerData.senderPort || 0,
        sessionKey:  answerData.sessionKey || '',
        codec:       answerData.codec || 'opus',
        quality:     answerData.quality || 'hd',
        caller:      callerAddress,
        callee:      answerData.callee || '',
        callerFingerprint: answerData.calleeFingerprint || '',
        sdpAnswer:   answerData.sdpAnswer || '',
      }

      const rules = this.encodeSignalRules()
      const attrs = this.encodeCallAttributes(ansToken)
      const stateData = this.encodeStateData(ansToken)

      const feePerKb = answerData.feePerKb || 1.1
      const result = await window.tokenBuilder.createCallSignalTx(
        'ANS-v1',
        rules,
        attrs,
        callerAddress,
        feePerKb,
        stateData,
      )

      this.log(`✓ Answer sent: ${result.txId}`, 'success')
      this.log(`https://whatsonchain.com/tx/${result.txId}`, 'info')

      return { txId: result.txId }
    } catch (err) {
      this.log(`Answer signal failed: ${err.message}`, 'error')
      throw err
    }
  }

}

// Export for browser
if (typeof window !== 'undefined') {
  window.CallTokenManager = CallTokenManager
}

// Export for modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CallTokenManager
}
