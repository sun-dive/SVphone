/**
 * Call Token Manager (v09.03) - P Protocol Conformant Signal Tokens
 *
 * Signal tokens (CALL, ANS, CXID) use the standard P v03 OP_RETURN format
 * with proper field separation:
 *
 *   tokenName:       "CALL-v1" | "ANS-v1" | "CXID-v1"
 *   tokenScript:     "" (empty, P2PKH fallback)
 *   tokenRules:      Standard 8-byte format (supply=1, div=0, restrictions=signal flags, version=1)
 *   tokenAttributes: Compact connection metadata (IP, port, session key, codec, addresses, fingerprint)
 *   stateData:       SDP offer/answer (the large payload)
 *
 * TX structure:
 *   Output 0: OP_RETURN (0 sats) — P v03 format
 *   Output 1: P2PKH 1-sat → recipient (WoC address history indexing)
 *   Output 2: P2PKH change → sender
 *
 * tokenRules restrictions bitfield:
 *   bit 0 (0x0001): CALL signal
 *   bit 1 (0x0002): ANS signal
 *   bit 2 (0x0004): CXID signal
 *   bit 3 (0x0008): audio
 *   bit 4 (0x0010): video
 */

const CODECS = { opus: 0, pcm: 1, aac: 2 }
const CODEC_IDS = ['opus', 'pcm', 'aac']
const QUALITIES = { sd: 0, hd: 1, vhd: 2 }
const QUALITY_IDS = ['sd', 'hd', 'vhd']

// Signal type flags for tokenRules restrictions bitfield
const SIGNAL_CALL = 0x0001
const SIGNAL_ANS  = 0x0002
const SIGNAL_CXID = 0x0004
const MEDIA_AUDIO = 0x0008
const MEDIA_VIDEO = 0x0010

class CallTokenManager {
  constructor(uiLogger) {
    this.log = uiLogger
  }

  /**
   * Encode connection metadata into tokenAttributes (no SDP — that goes in stateData).
   * @param {Object} callToken - {senderIp, senderPort, sessionKey, codec, quality, mediaTypes, caller, callee, senderIp4, senderIp6, callerFingerprint}
   * @returns {string} Hex-encoded binary
   */
  encodeCallAttributes(callToken) {
    try {
      const bytes = []

      // Version marker (0x02 = v09.03 format, SDP moved to stateData)
      bytes.push(0x02)

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

      // Session key (1-byte length prefix + N bytes)
      const keyData = callToken.sessionKey
      const keyBuf = typeof keyData === 'string'
        ? new TextEncoder().encode(keyData)
        : keyData
      bytes.push(keyBuf.length)
      bytes.push(...keyBuf)

      // Codec (1 byte enum)
      bytes.push(CODECS[callToken.codec] ?? 0)

      // Quality (1 byte enum)
      bytes.push(QUALITIES[callToken.quality] ?? 1)

      // Media types (1 byte bitmask: bit0=audio, bit1=video)
      let mediaBitmask = 0
      if (callToken.mediaTypes?.includes('audio')) mediaBitmask |= 0x01
      if (callToken.mediaTypes?.includes('video')) mediaBitmask |= 0x02
      bytes.push(mediaBitmask)

      // Caller address (1-byte length prefix + N bytes UTF-8)
      const callerBuf = new TextEncoder().encode(callToken.caller || '')
      bytes.push(callerBuf.length)
      bytes.push(...callerBuf)

      // Callee address (1-byte length prefix + N bytes UTF-8)
      const calleeBuf = new TextEncoder().encode(callToken.callee || '')
      bytes.push(calleeBuf.length)
      bytes.push(...calleeBuf)

      // senderIp4 (1-byte length: 4=present, 0=absent + 0|4 bytes)
      const ip4 = callToken.senderIp4 || null
      if (ip4 && /^\d+\.\d+\.\d+\.\d+$/.test(ip4)) {
        bytes.push(4)
        bytes.push(...ip4.split('.').map(p => parseInt(p, 10)))
      } else {
        bytes.push(0)
      }

      // senderIp6 (1-byte length: 16=present, 0=absent + 0|16 bytes)
      const ip6 = callToken.senderIp6 || null
      if (ip6 && ip6.includes(':')) {
        bytes.push(16)
        bytes.push(...this._ipv6ToBytes(ip6))
      } else {
        bytes.push(0)
      }

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
    const sdpBuf = new TextEncoder().encode(sdpData)
    return Array.from(sdpBuf).map(b => ('0' + b.toString(16)).slice(-2)).join('')
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
   * Build standard 8-byte tokenRules for signal tokens.
   * Format: supply(2) + divisibility(2) + restrictions(2) + version(2), all uint16 LE.
   * @param {string} signalType - 'CALL' | 'ANS' | 'CXID'
   * @param {string[]} mediaTypes - ['audio'] or ['audio', 'video']
   * @returns {string} 16-char hex string (8 bytes)
   */
  encodeSignalRules(signalType, mediaTypes = ['audio']) {
    const supply = 1
    const divisibility = 0
    let restrictions = 0
    if (signalType === 'CALL') restrictions |= SIGNAL_CALL
    else if (signalType === 'ANS') restrictions |= SIGNAL_ANS
    else if (signalType === 'CXID') restrictions |= SIGNAL_CXID
    if (mediaTypes?.includes('audio')) restrictions |= MEDIA_AUDIO
    if (mediaTypes?.includes('video')) restrictions |= MEDIA_VIDEO
    const version = 1

    // uint16 LE encoding
    const buf = new Uint8Array(8)
    buf[0] = supply & 0xFF;       buf[1] = (supply >> 8) & 0xFF
    buf[2] = divisibility & 0xFF; buf[3] = (divisibility >> 8) & 0xFF
    buf[4] = restrictions & 0xFF; buf[5] = (restrictions >> 8) & 0xFF
    buf[6] = version & 0xFF;      buf[7] = (version >> 8) & 0xFF
    return Array.from(buf).map(b => ('0' + b.toString(16)).slice(-2)).join('')
  }

  /**
   * Decode connection metadata from tokenAttributes (no SDP — that's in stateData).
   * @param {string} hexStr - Hex-encoded binary tokenAttributes
   * @returns {Object|null} {senderIp, senderPort, sessionKey, codec, quality, mediaTypes, caller, callee, senderIp4, senderIp6, callerFingerprint}
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

      // Session key
      const keyLen = bytes[offset++]
      const keyBuf = bytes.slice(offset, offset + keyLen)
      const sessionKey = new TextDecoder().decode(new Uint8Array(keyBuf))
      offset += keyLen

      // Codec and Quality
      const codec = CODEC_IDS[bytes[offset++]] || 'opus'
      const quality = QUALITY_IDS[bytes[offset++]] || 'hd'

      // Media types
      const mediaBitmask = bytes[offset++]
      const mediaTypes = []
      if (mediaBitmask & 0x01) mediaTypes.push('audio')
      if (mediaBitmask & 0x02) mediaTypes.push('video')

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

      // senderIp4 (1-byte len: 4=present, 0=absent)
      let senderIp4 = null
      if (offset < bytes.length) {
        const ip4Len = bytes[offset++]
        if (ip4Len === 4) {
          senderIp4 = `${bytes[offset]}.${bytes[offset+1]}.${bytes[offset+2]}.${bytes[offset+3]}`
          offset += 4
        }
      }

      // senderIp6 (1-byte len: 16=present, 0=absent)
      let senderIp6 = null
      if (offset < bytes.length) {
        const ip6Len = bytes[offset++]
        if (ip6Len === 16) {
          senderIp6 = this._bytesToIPv6(bytes.slice(offset, offset + 16))
          offset += 16
        }
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

      return { senderIp, senderPort, sessionKey, codec, quality, mediaTypes, caller, callee, senderIp4, senderIp6, callerFingerprint }
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
   * @param {Object} callToken - {caller, callee, senderIp, senderPort, sessionKey, codec, quality, mediaTypes, sdpOffer}
   * @returns {Promise<{txId: string}>}
   */
  async createAndBroadcastCallToken(callToken) {
    this.log(`Sending call signal to ${callToken.callee}`, 'info')
    try {
      const prefix = callToken.tokenPrefix || 'CALL'
      const signalType = prefix === 'CXID' ? 'CXID' : 'CALL'
      const tokenName = `${prefix}-v1`
      const rules = this.encodeSignalRules(signalType, callToken.mediaTypes)
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
   * @param {Object} answerData - {callee, senderIp, senderPort, sessionKey, codec, quality, mediaTypes, sdpAnswer, calleeFingerprint}
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
        mediaTypes:  answerData.mediaTypes || ['audio'],
        caller:      callerAddress,
        callee:      answerData.callee || '',
        senderIp4:   answerData.senderIp4 || null,
        senderIp6:   answerData.senderIp6 || null,
        callerFingerprint: answerData.calleeFingerprint || '',
        sdpAnswer:   answerData.sdpAnswer || '',
      }

      const rules = this.encodeSignalRules('ANS', ansToken.mediaTypes)
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
