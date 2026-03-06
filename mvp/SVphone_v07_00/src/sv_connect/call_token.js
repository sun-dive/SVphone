/**
 * Call Token Manager (v06.08) - PPV (Proof Payment Verification) Implementation
 *
 * Orchestrates full lifecycle of SVphone call tokens with instant transfer UX:
 * - Creates genesis token with CALL_TOKEN_RULES
 * - Waits for genesis confirmation (~10 min, required before transfer)
 * - Transfers token to recipient (instant after genesis confirmed)
 * - Continues Merkle proof verification in background (optional)
 *
 * PPV Model: Genesis MUST be confirmed before transfer. Subsequent transfers are instant.
 */

// Shared enum constants (same as CallSignaling)
const CODECS = { opus: 0, pcm: 1, aac: 2 }
const CODEC_IDS = ['opus', 'pcm', 'aac']
const QUALITIES = { sd: 0, hd: 1, vhd: 2 }
const QUALITY_IDS = ['sd', 'hd', 'vhd']

// CALL token rules
const CALL_TOKEN_RULES = {
  supply: 1,
  divisibility: 0,
  restrictions: 'dynamic',
  version: 1
}

class CallTokenManager {
  constructor(tokenBuilder, uiLogger) {
    this.tokenBuilder = tokenBuilder
    this.log = uiLogger // UI logging function
  }

  /**
   * Encode call attributes into binary format (~50-100 bytes + SDP)
   * @param {Object} callToken - Token with connection info and SDP
   * @returns {string} Hex-encoded binary
   */
  encodeCallAttributes(callToken) {
    try {
      const bytes = []

      // Version marker (0x01 = binary format v1)
      bytes.push(0x01)

      // Note: Address verification hashes are in tokenRules.restrictions (immutable after genesis)
      // tokenAttributes only contains connection data (IP, port, key, codec, quality, SDP)

      // IP address and port
      const ip = callToken.senderIp
      const port = callToken.senderPort

      // Detect IP version (0=IPv4, 1=IPv6)
      const isIPv6 = ip.includes(':')
      const ipBits = isIPv6 ? 1 : 0

      if (!isIPv6) {
        // IPv4: 4 bytes
        const parts = ip.split('.').map(p => parseInt(p, 10))
        bytes.push((ipBits << 7) | (parts[0] & 0x7F))
        bytes.push(parts[1])
        bytes.push(parts[2])
        bytes.push(parts[3])
      } else {
        // IPv6: 16 bytes (simplified)
        const ipv6Buf = this.ipv6ToBytes(ip)
        bytes.push((ipBits << 7) | (ipv6Buf[0] & 0x7F))
        bytes.push(...ipv6Buf.slice(1))
      }

      // Port (2 bytes, big-endian)
      bytes.push((port >> 8) & 0xFF)
      bytes.push(port & 0xFF)

      // Session key (variable-length)
      const keyData = callToken.sessionKey
      const keyBuf = typeof keyData === 'string'
        ? new TextEncoder().encode(keyData)
        : keyData
      bytes.push(keyBuf.length)
      bytes.push(...keyBuf)

      // Codec and Quality (1 byte enums)
      bytes.push(CODECS[callToken.codec] ?? 0)
      bytes.push(QUALITIES[callToken.quality] ?? 1)

      // Media types (1 byte bitmask)
      let mediaBitmask = 0
      if (callToken.mediaTypes?.includes('audio')) mediaBitmask |= 0x01
      if (callToken.mediaTypes?.includes('video')) mediaBitmask |= 0x02
      bytes.push(mediaBitmask)

      // SDP Offer or Answer (variable-length, 2-byte length prefix)
      // Supports both outgoing offer (callToken.sdpOffer) and response answer (callToken.sdpAnswer)
      const sdpData = callToken.sdpOffer || callToken.sdpAnswer || ''
      const sdpBuf = new TextEncoder().encode(sdpData)
      bytes.push((sdpBuf.length >> 8) & 0xFF)  // Length high byte
      bytes.push(sdpBuf.length & 0xFF)          // Length low byte
      bytes.push(...sdpBuf)

      // Convert to hex string
      return bytes.map(b => ('0' + b.toString(16)).slice(-2)).join('')
    } catch (error) {
      console.error(`[CallToken] Failed to encode attributes:`, error)
      return '00'  // Fallback to empty if encoding fails
    }
  }

  /**
   * Helper: Convert IPv6 string to bytes
   * @private
   */
  ipv6ToBytes(ip) {
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

  /**
   * Helper: Compute 32-bit truncated SHA256 hash of an address
   * Returns first 8 hex characters (32 bits) for compact identification
   * @private
   */
  async hashAddress(address) {
    try {
      const encoder = new TextEncoder()
      const data = encoder.encode(address)
      const hashBuffer = await crypto.subtle.digest('SHA-256', data)
      const hashArray = Array.from(new Uint8Array(hashBuffer))
      const hashHex = hashArray.map(b => ('0' + b.toString(16)).slice(-2)).join('')
      return hashHex.substring(0, 8)  // Return first 32 bits (8 hex chars)
    } catch (error) {
      console.error(`[CallToken] Failed to hash address:`, error)
      return '00000000'  // Fallback if hashing fails
    }
  }

  /**
   * Verify token restrictions contain this address's hash
   * Both caller and callee check if their own hash is in restrictions (either position)
   * Format: restrictions = callerHash (8 hex) + calleeHash (8 hex)
   *
   * @param {Object} token - Token object with tokenRules or restrictions field
   * @param {string} myAddress - My BSV address to verify
   * @returns {Promise<{valid: boolean, message: string, myHashPosition: string}>}
   */
  async verifyTokenForMe(token, myAddress) {
    try {
      const restrictions = token.tokenRules?.restrictions || token.restrictions
      if (!restrictions || restrictions.length < 16) {
        return { valid: false, message: 'Invalid restrictions format', myHashPosition: 'none' }
      }

      const hash1 = restrictions.substring(0, 8)
      const hash2 = restrictions.substring(8, 16)
      const myHash = await this.hashAddress(myAddress)

      if (myHash === hash1) {
        return { valid: true, message: 'Token is for me (hash verified)', myHashPosition: 'first' }
      } else if (myHash === hash2) {
        return { valid: true, message: 'Token is for me (hash verified)', myHashPosition: 'second' }
      } else {
        return { valid: false, message: 'Token is NOT for me', myHashPosition: 'none' }
      }
    } catch (error) {
      console.error(`[CallToken] Verification error:`, error.message)
      return { valid: false, message: `Error: ${error.message}`, myHashPosition: 'none' }
    }
  }

  /**
   * Broadcast call answer response token back to caller
   * Transfer with SDP Answer in tokenAttributes (tokenRules remain immutable)
   * @param {string} tokenId - Call token ID to transfer
   * @param {string} callerAddress - Caller's address (recipient)
   * @param {Object} answerData - {sdpAnswer, senderIp, senderPort, sessionKey, codec, quality, mediaTypes}
   * @returns {Promise<Object>} {txId, tokenId}
   */
  async broadcastCallAnswer(tokenId, callerAddress, answerData) {
    try {
      const answerAttributes = this.encodeCallAttributes({
        sdpAnswer: answerData.sdpAnswer,
        senderIp: answerData.senderIp,
        senderPort: answerData.senderPort,
        sessionKey: answerData.sessionKey,
        codec: answerData.codec,
        quality: answerData.quality,
        mediaTypes: answerData.mediaTypes
      })

      const transferResult = await this.tokenBuilder.createTransfer(tokenId, callerAddress, {
        tokenAttributes: answerAttributes
      })

      this.log(`✓ Answer token sent: ${transferResult.txId}`, 'success')
      this.log(`https://whatsonchain.com/tx/${transferResult.txId}`, 'info')
      return { txId: transferResult.txId, tokenId: tokenId }
    } catch (err) {
      console.error(`[CallToken] Answer broadcast failed:`, err.message)
      this.log(`Answer broadcast failed: ${err.message}`, 'error')
      throw err
    }
  }

  /**
   * Create and broadcast call token to blockchain
   * PPV flow: Genesis → Wait for confirmation → Transfer (instant after confirmed)
   * @param {Object} callToken - {caller, callee, senderIp, senderPort, sessionKey, codec, quality, mediaTypes}
   * @returns {Promise<Object>} {tokenId, txId, tokenIds}
   */
  async createAndBroadcastCallToken(callToken) {
    const callerIdent = callToken.caller?.slice(0, 5) || 'unkn'
    this.log(`Creating call token for ${callToken.callee}`, 'info')

    try {
      // Compute address hashes (immutable in tokenRules.restrictions)
      const callerHash = await this.hashAddress(callToken.caller)
      const calleeHash = await this.hashAddress(callToken.callee)
      const restrictionsValue = callerHash + calleeHash

      // Encode connection info into tokenAttributes
      const encodedAttributes = this.encodeCallAttributes(callToken)

      // Create genesis token
      const result = await this.tokenBuilder.createGenesis({
        tokenName: `CALL-${callerIdent}`,
        tokenScript: '',
        attributes: encodedAttributes,
        supply: CALL_TOKEN_RULES.supply,
        divisibility: CALL_TOKEN_RULES.divisibility,
        restrictions: restrictionsValue,
        rulesVersion: CALL_TOKEN_RULES.version,
        stateData: '00'
      })

      const tokenId = result.tokenIds?.[0] || result.tokenId
      const genesisTx = result.txId

      this.log(`✓ Token created: ${tokenId}`, 'success')
      this.log(`https://whatsonchain.com/tx/${genesisTx}`, 'info')
      this.log('⏳ Waiting for genesis confirmation (~10 min)...', 'info')

      // Wait for genesis confirmation
      try {
        const genesisConfirmed = await this.tokenBuilder.pollForProof(tokenId, result.txId, () => {})

        if (!genesisConfirmed) {
          throw new Error('Genesis confirmation timed out')
        }
        this.log('✓ Genesis confirmed - transferring (instant)...', 'success')
      } catch (err) {
        this.log(`Genesis confirmation error: ${err.message}`, 'error')
        throw err
      }

      // Transfer to recipient (instant after genesis confirmed)
      try {
        const transferResult = await this.tokenBuilder.createTransfer(tokenId, callToken.callee)
        this.log(`✓ Token transferred: ${transferResult.txId}`, 'success')
        this.log(`https://whatsonchain.com/tx/${transferResult.txId}`, 'info')

        // Background proof polling (non-blocking)
        this.tokenBuilder.pollForProof(tokenId, transferResult.txId, () => {}).catch(() => {})

        return { tokenId, txId: result.txId, tokenIds: result.tokenIds }
      } catch (err) {
        this.log(`Token transfer failed: ${err.message}`, 'warning')
        throw err
      }
    } catch (err) {
      console.error(`[CallToken] Creation failed:`, err.message)
      this.log(`Token creation failed: ${err.message}`, 'error')
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
