/**
 * SVphone Call Signaling Layer (v06.00)
 *
 * Implements call initiation, acceptance, and termination using blockchain-based
 * P tokens for signaling and WebRTC for peer-to-peer media.
 *
 * Call flow: Caller broadcasts token → Recipient polls/verifies → P2P connection established
 *
 * Call token format (P protocol, v1):
 * - tokenName: "CALL-XXXXX"
 * - tokenAttributes: [Version][IP][Port][SessionKey][Codec][Quality][MediaTypes][SDP]
 * - tokenRules.restrictions: caller_hash || callee_hash (32-bit SHA256 for address verification)
 */

class CallSignaling {
  // Codec enumeration
  static CODECS = { opus: 0, pcm: 1, aac: 2 }
  static CODEC_IDS = ['opus', 'pcm', 'aac']

  // Quality enumeration
  static QUALITIES = { sd: 0, hd: 1, vhd: 2 }
  static QUALITY_IDS = ['sd', 'hd', 'vhd']

  constructor(options = {}) {
    this.callTokens = new Map() // Map<callTokenId, CallToken>
    this.activeCalls = new Map() // Map<peerId, ActiveCall>
    this.listeners = new Map() // Map<eventName, [callbacks]>

    // Configuration
    this.rpcUrl = options.rpcUrl || 'http://localhost:8332'
    this.pollingInterval = options.pollingInterval || 5000 // 5s poll for incoming tokens
    this.callTimeout = options.callTimeout || 60000 // 60s call ring timeout
    this.signalingTimeout = options.signalingTimeout || 10000 // 10s for call answer

    // State
    this.isPolling = false
    this.pollHandle = null
    this.myAddress = null
    this.myIp = null
    this.myPort = null
  }

  /**
   * Encode call attributes into binary format for blockchain storage (~100-150 bytes)
   * @param {Object} attributes - {senderIp, senderPort, sessionKey, codec, quality, mediaTypes}
   * @returns {string} Hex-encoded binary
   */
  encodeTokenAttributes(attributes) {
    try {
      const bytes = []

      // Version marker (0x01 = binary format v1)
      bytes.push(0x01)

      // NOTE: Caller and callee are NOT encoded here
      // They are stored in transaction metadata and verified via 32-bit SHA256 hashes in tokenRules.restrictions
      // This ensures addresses cannot be spoofed and keeps tokenAttributes focused on connection data

      // IP address and port
      const ip = attributes.senderIp
      const port = attributes.senderPort

      // Detect IP version (0=IPv4, 1=IPv6)
      const isIPv6 = ip.includes(':')
      const ipBits = isIPv6 ? 1 : 0

      if (!isIPv6) {
        // IPv4: 4 bytes (with version bit in MSB)
        const parts = ip.split('.').map(p => parseInt(p, 10))
        bytes.push((ipBits << 7) | (parts[0] & 0x7F))
        bytes.push(parts[1])
        bytes.push(parts[2])
        bytes.push(parts[3])
      } else {
        // IPv6: 16 bytes (with version bit in MSB of first byte)
        const ipv6Buf = this.ipv6ToBytes(ip)
        bytes.push((ipBits << 7) | (ipv6Buf[0] & 0x7F))
        bytes.push(...ipv6Buf.slice(1))
      }

      // Port (2 bytes, big-endian)
      bytes.push((port >> 8) & 0xFF)
      bytes.push(port & 0xFF)

      // Session key (variable-length binary)
      const keyData = attributes.sessionKey
      const keyBuf = typeof keyData === 'string'
        ? new TextEncoder().encode(keyData)
        : keyData
      bytes.push(keyBuf.length)
      bytes.push(...keyBuf)

      // Codec (1 byte enum: 0=opus, 1=pcm, 2=aac)
      bytes.push(CallSignaling.CODECS[attributes.codec] ?? 0)

      // Quality (1 byte enum: 0=sd, 1=hd, 2=vhd)
      bytes.push(CallSignaling.QUALITIES[attributes.quality] ?? 1)

      // Media types (1 byte bitmask: bit0=audio, bit1=video)
      let mediaBitmask = 0
      if (attributes.mediaTypes?.includes('audio')) mediaBitmask |= 0x01
      if (attributes.mediaTypes?.includes('video')) mediaBitmask |= 0x02
      bytes.push(mediaBitmask)

      // Convert bytes to hex string
      return bytes.map(b => ('0' + b.toString(16)).slice(-2)).join('')
    } catch (error) {
      console.error('[CallSignaling] Failed to encode tokenAttributes:', error)
      return ''
    }
  }

  /**
   * Parse tokenAttributes from binary format
   * @private
   */
  parseTokenAttributes(tokenAttributesHex) {
    if (!tokenAttributesHex) return {}

    try {
      // Convert hex to bytes
      const bytes = []
      for (let i = 0; i < tokenAttributesHex.length; i += 2) {
        bytes.push(parseInt(tokenAttributesHex.substr(i, 2), 16))
      }

      if (bytes.length === 0) {
        console.warn('[CallSignaling] parseTokenAttributes: empty bytes array')
        return {}
      }

      // Decode binary format v1
      return this.decodeBinaryAttributes(bytes)
    } catch (error) {
      console.error('[CallSignaling] Failed to parse tokenAttributes:', error)
      return {}
    }
  }

  /**
   * Decode binary format v1 attributes
   * @private
   */
  decodeBinaryAttributes(bytes) {
    let offset = 1 // Skip version byte

    // IP address (4 or 16 bytes based on version bit)
    const ipTypeByte = bytes[offset++]
    const isIPv6 = (ipTypeByte >> 7) & 1
    const ipBytes = [ipTypeByte & 0x7F, ...bytes.slice(offset, offset + (isIPv6 ? 15 : 3))]
    const senderIp = isIPv6
      ? this.bytesToIPv6(ipBytes)
      : `${ipBytes[0]}.${bytes[offset+1]}.${bytes[offset+2]}.${bytes[offset+3]}`
    offset += isIPv6 ? 15 : 3

    // Port (2 bytes)
    const senderPort = (bytes[offset] << 8) | bytes[offset + 1]
    offset += 2

    // Session key
    const keyLen = bytes[offset++]
    const keyBuf = bytes.slice(offset, offset + keyLen)
    const sessionKey = new TextDecoder().decode(new Uint8Array(keyBuf))
    offset += keyLen

    // Codec
    const codec = CallSignaling.CODEC_IDS[bytes[offset++]] || 'opus'

    // Quality
    const quality = CallSignaling.QUALITY_IDS[bytes[offset++]] || 'hd'

    // Media types (bitmask: bit0=audio, bit1=video)
    const mediaTypeBitmask = bytes[offset++]
    const mediaTypes = []
    if (mediaTypeBitmask & 0x01) mediaTypes.push('audio')
    if (mediaTypeBitmask & 0x02) mediaTypes.push('video')

    // SDP Offer (variable-length, 2-byte length prefix)
    const sdpLen = (bytes[offset] << 8) | bytes[offset + 1]
    offset += 2
    const sdpBuf = bytes.slice(offset, offset + sdpLen)
    const sdpOffer = new TextDecoder().decode(new Uint8Array(sdpBuf))

    return {
      senderIp,
      senderPort,
      sessionKey,
      codec,
      quality,
      mediaTypes,
      sdpOffer
    }
  }

  /**
   * Helper: Convert IPv6 string to 16-byte array
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
   * Helper: Convert 16-byte array to IPv6 string
   * @private
   */
  bytesToIPv6(bytes) {
    const parts = []
    for (let i = 0; i < 16; i += 2) {
      parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
    }
    return parts.join(':')
  }

  /**
   * Extract caller and callee addresses from a CALL token
   * Tries stored tokens first, then token metadata.
   * @private
   */
  extractCallerCalleeFromToken(token) {
    const storedToken = this.callTokens.get(token.tokenId)

    // Check stored token (our own initiated calls or previous responses)
    if (storedToken?.caller && storedToken?.callee) {
      // Skip if same UTXO location (not returned yet)
      if (storedToken.currentTxId === token.currentTxId &&
          storedToken.currentOutputIndex === token.currentOutputIndex) {
        return null
      }
      // Return-to-sender: use original addresses
      return { caller: storedToken.caller, callee: storedToken.callee }
    }

    // Use addresses from token metadata (from tokenBuilder)
    if (token.caller && token.callee) {
      return { caller: token.caller, callee: token.callee }
    }

    return null
  }

  /**
   * Initialize the signaling layer with wallet address and network info
   */
  async initialize(myAddress, myIp, myPort) {
    this.myAddress = myAddress
    this.myIp = myIp
    this.myPort = myPort

    console.log('[CallSignaling] Initialized', {
      address: myAddress,
      ip: myIp,
      port: myPort
    })
  }

  /**
   * Create call initiation token with connection info
   * @param {string} calleeAddress - Recipient BSV address
   * @param {string} sessionKey - Ephemeral DH key (base64)
   * @param {Object} options - {codec, quality, mediaTypes}
   * @returns {Object} Call token ready to broadcast
   */
  createCallToken(calleeAddress, sessionKey, options = {}) {
    const callToken = {
      // Call attributes (mutable, stored in tokenAttributes)
      caller: this.myAddress,
      callee: calleeAddress,
      senderIp: this.myIp,
      senderPort: this.myPort,
      sessionKey: sessionKey, // Ephemeral DH key for encryption

      // Call options
      codec: options.codec || 'opus',
      quality: options.quality || 'hd',
      mediaTypes: options.mediaTypes || ['audio', 'video'],

      // State (mutable, stored in stateData)
      status: 'ringing', // ringing → answered → connected → ended
      initiatedAt: Date.now(),
      timestamp: Math.floor(Date.now() / 1000), // Block height approximation

      // Call ID (computed from token ID after broadcast)
      callTokenId: null,
      currentTxId: null
    }

    console.log('[CallSignaling] Created call token:', {
      calleeAddress,
      codec: callToken.codec,
      quality: callToken.quality
    })

    return callToken
  }

  /**
   * Broadcast call token to blockchain (mint new or use existing)
   * @param {Object} callToken - Token to broadcast
   * @param {Function} mintTokenFn - Optional: (token) => Promise<{txId, tokenId}>
   * @returns {Object} {txId, tokenId, callTokenId}
   */
  async broadcastCallToken(callToken, mintTokenFn) {
    try {
      let result

      if (mintTokenFn) {
        // Mint new token if mintTokenFn provided
        result = await mintTokenFn(callToken)
      } else {
        // Use existing token if no mintTokenFn provided
        // For now, generate a pseudo-result with call token data
        // The actual token broadcasting will use existing tokens from tokenBuilder
        result = {
          tokenId: callToken.callTokenId || `existing-${Date.now()}`,
          txId: callToken.currentTxId || `existing-tx-${Date.now()}`
        }
      }

      callToken.callTokenId = result.tokenId
      callToken.currentTxId = result.txId

      this.callTokens.set(result.tokenId, callToken)

      this.emit('call:initiated', {
        callTokenId: result.tokenId,
        txId: result.txId,
        calleeAddress: callToken.callee,
        timestamp: Date.now()
      })

      console.log('[CallSignaling] Broadcasted call token:', {
        tokenId: result.tokenId,
        txId: result.txId,
        callee: callToken.callee,
        mode: mintTokenFn ? 'new-mint' : 'existing-token'
      })

      return {
        txId: result.txId,
        tokenId: result.tokenId,
        callTokenId: result.tokenId
      }
    } catch (error) {
      console.error('[CallSignaling] Failed to broadcast call token:', error)
      throw error
    }
  }

  /**
   * Start polling for incoming call tokens
   *
   * @param {Function} checkIncomingTokensFn - Function to check incoming tokens
   * @param {Function} verifyTokenFn - Function to verify token via SPV
   */
  async startPolling(checkIncomingTokensFn, verifyTokenFn) {
    if (this.isPolling) {
      console.warn('[CallSignaling] Already polling for incoming tokens')
      return
    }

    this.isPolling = true
    console.log('[CallSignaling] Started polling for incoming call tokens')

    const pollOnce = async () => {
      try {
        const incomingTokens = await checkIncomingTokensFn(this.myAddress)

        for (const token of incomingTokens) {
          // Check if it's a call initiation token (format: CALL-XXXXX)
          if (!token.tokenName?.startsWith('CALL-')) continue

          // Parse tokenAttributes to extract call metadata
          const attributes = this.parseTokenAttributes(token.tokenAttributes)

          // Extract caller/callee addresses (best-effort, not blocking)
          const addressPair = this.extractCallerCalleeFromToken(token)
          if (addressPair) {
            token.caller = addressPair.caller
            token.callee = addressPair.callee
          }

          // Merge parsed attributes into token
          Object.assign(token, attributes)

          // Route to appropriate handler based on caller/callee
          const isIncomingCall = token.callee === this.myAddress
          const isResponseToken = token.caller === this.myAddress

          if (isIncomingCall) {
            this.handleIncomingCall(token)
          } else if (isResponseToken) {
            this.handleCallResponse(token, attributes)
          } else {
            this.emit('call:token-received', { token, attributes })
          }

          // Run SPV verification in background (non-blocking)
          verifyTokenFn(token).then(verification => {
            if (!verification.valid) {
              console.warn(`[CallSignaling] SPV verification failed:`, {
                tokenId: token.tokenId?.slice(0, 10),
                reason: verification.reason
              })
            }
          }).catch(error => {
            console.error(`[CallSignaling] SPV verification error:`, error.message)
          })
        }
      } catch (error) {
        console.error('[CallSignaling] Polling error:', error.message)
      }

      if (this.isPolling) {
        this.pollHandle = setTimeout(pollOnce, this.pollingInterval)
      }
    }

    // Start polling
    this.pollHandle = setTimeout(pollOnce, 100) // Initial poll after 100ms
  }

  /**
   * Stop polling for incoming tokens
   */
  stopPolling() {
    if (this.pollHandle) {
      clearTimeout(this.pollHandle)
      this.pollHandle = null
    }
    this.isPolling = false
    console.log('[CallSignaling] Stopped polling for incoming call tokens')
  }

  /**
   * Handle incoming call token
   * @private
   */
  handleIncomingCall(token) {
    const callToken = {
      callTokenId: token.tokenId,
      currentTxId: token.currentTxId,
      caller: token.caller,
      callee: token.callee,
      senderIp: token.senderIp,
      senderPort: token.senderPort,
      sessionKey: token.sessionKey,
      codec: token.codec,
      quality: token.quality,
      mediaTypes: token.mediaTypes || ['audio', 'video'],
      status: 'ringing',
      receivedAt: Date.now()
    }

    this.callTokens.set(token.tokenId, callToken)

    this.emit('call:incoming', {
      callTokenId: token.tokenId,
      caller: token.caller,
      callerIp: token.senderIp,
      callerPort: token.senderPort,
      codec: token.codec,
      quality: token.quality,
      timestamp: Date.now()
    })

    console.log('[CallSignaling] Incoming call from:', token.caller)
  }

  /**
   * Handle call response token from callee
   * @private
   */
  handleCallResponse(token, attributes) {
    if (!attributes?.sdpAnswer) return

    const eventData = {
      callTokenId: token.tokenId,
      caller: token.caller,
      callee: token.callee,
      calleeIp: attributes.senderIp,
      calleePort: attributes.senderPort,
      calleeSessionKey: attributes.sessionKey,
      sdpAnswer: attributes.sdpAnswer,
      codec: attributes.codec,
      quality: attributes.quality,
      mediaTypes: attributes.mediaTypes,
      timestamp: Date.now()
    }

    this.emit('call:answered', eventData)
    console.log('[CallSignaling] Call answer received from', token.caller?.slice(0, 20))
  }

  /**
   * Accept incoming call
   * @param {string} callTokenId - Call token ID to accept
   * @param {Object} options - Acceptance options
   * @returns {Object} Answer token to send back
   */
  acceptCall(callTokenId, options = {}) {
    const callToken = this._validateCallToken(callTokenId)

    callToken.status = 'answered'
    callToken.answeredAt = Date.now()

    const answerToken = {
      type: 'call-answer',
      callTokenId: callTokenId,
      answerer: this.myAddress,
      answererIp: this.myIp,
      answererPort: this.myPort,
      answererSessionKey: options.sessionKey || this.generateSessionKey(),
      timestamp: Date.now()
    }

    // Emit call:answered event with CALLER's connection info (for callee to establish P2P back)
    // callToken contains the CALLER's information (from the incoming call token)
    this.emit('call:answered', {
      callTokenId: callTokenId,
      answerer: this.myAddress,
      // Include caller's connection info from the incoming call token so callee can connect back
      calleeAddress: callToken.caller,      // Caller's address
      calleeIp: callToken.senderIp,         // Caller's IP (from incoming token)
      calleePort: callToken.senderPort,     // Caller's port (from incoming token)
      calleeSessionKey: callToken.sessionKey, // Caller's session key
      timestamp: Date.now()
    })

    console.debug('[CallSignaling] Emitting call:answered with caller connection info:', {
      calleeAddress: callToken.caller?.slice(0,20),
      calleeIp: callToken.senderIp,
      calleePort: callToken.senderPort,
      answerer: this.myAddress?.slice(0,20)
    })
    console.log('[CallSignaling] Accepted call:', callTokenId)

    return answerToken
  }

  /**
   * Broadcast call answer token back to caller
   * @param {string} callTokenId - Call token ID
   * @param {string} callerAddress - Caller's address (recipient)
   * @param {Object} answerData - {sdpAnswer, senderIp, senderPort, sessionKey, codec, quality, mediaTypes}
   * @param {Function} broadcastFn - Optional broadcast function
   */
  async broadcastCallAnswer(callTokenId, callerAddress, answerData, broadcastFn) {
    if (!broadcastFn) {
      console.warn('[CallSignaling] No broadcast function provided')
      return { callTokenId, txId: null }
    }

    try {
      const result = await broadcastFn(callTokenId, callerAddress, answerData)

      this.emit('call:answer-broadcasted', {
        callTokenId: callTokenId,
        txId: result.txId,
        timestamp: Date.now()
      })

      console.log('[CallSignaling] Answer broadcasted:', result.txId)
      return result
    } catch (error) {
      console.error('[CallSignaling] Failed to broadcast answer:', error.message)
      throw error
    }
  }

  /**
   * Reject incoming call
   * @param {string} callTokenId - Call token ID to reject
   * @param {string} reason - Rejection reason
   */
  rejectCall(callTokenId, reason = 'user-declined') {
    const callToken = this._validateCallToken(callTokenId)

    callToken.status = 'rejected'
    callToken.rejectedAt = Date.now()
    callToken.rejectionReason = reason

    this.emit('call:rejected', {
      callTokenId: callTokenId,
      reason: reason,
      timestamp: Date.now()
    })

    console.log('[CallSignaling] Rejected call:', callTokenId)
  }

  /**
   * Update call state
   * @param {string} callTokenId - Call token ID
   * @param {string} status - New status (connecting, connected, ended)
   * @param {Object} metadata - Additional metadata to store
   */
  updateCallState(callTokenId, status, metadata = {}) {
    const callToken = this._validateCallToken(callTokenId)

    callToken.status = status
    Object.assign(callToken, metadata)

    this.emit('call:state-changed', {
      callTokenId: callTokenId,
      status: status,
      metadata: metadata,
      timestamp: Date.now()
    })

    console.log('[CallSignaling] Updated call state:', { callTokenId, status })
  }

  /**
   * End call
   * @param {string} callTokenId - Call token ID to end
   * @param {Object} stats - Call statistics
   */
  endCall(callTokenId, stats = {}) {
    const callToken = this._validateCallToken(callTokenId)

    const duration = callToken.connectedAt
      ? Date.now() - callToken.connectedAt
      : 0

    callToken.status = 'ended'
    callToken.endedAt = Date.now()
    callToken.duration = duration
    callToken.stats = stats

    this.emit('call:ended', {
      callTokenId: callTokenId,
      duration: duration,
      stats: stats,
      timestamp: Date.now()
    })

    console.log('[CallSignaling] Ended call:', {
      callTokenId: callTokenId,
      duration: duration
    })
  }

  /**
   * Get call token details
   */
  getCallToken(callTokenId) {
    return this.callTokens.get(callTokenId)
  }

  /**
   * Validate call token exists (helper)
   * @private
   */
  _validateCallToken(callTokenId) {
    const callToken = this.callTokens.get(callTokenId)
    if (!callToken) {
      throw new Error(`Call token not found: ${callTokenId}`)
    }
    return callToken
  }

  /**
   * Generate ephemeral session key (base64-encoded random bytes)
   * @private
   */
  generateSessionKey() {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    return btoa(String.fromCharCode(...bytes))
  }

  /**
   * Event emitter methods
   */
  on(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, [])
    }
    this.listeners.get(eventName).push(callback)
  }

  off(eventName, callback) {
    const callbacks = this.listeners.get(eventName)
    if (callbacks) {
      const index = callbacks.indexOf(callback)
      if (index > -1) {
        callbacks.splice(index, 1)
      }
    }
  }

  emit(eventName, data) {
    const callbacks = this.listeners.get(eventName)
    if (callbacks) {
      callbacks.forEach(cb => {
        try {
          cb(data)
        } catch (error) {
          console.error(`[CallSignaling] Error in ${eventName} handler:`, error)
        }
      })
    }
  }
}

// Export for browser
if (typeof window !== 'undefined') {
  window.CallSignaling = CallSignaling
}

// Export for Node.js/modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CallSignaling
}
