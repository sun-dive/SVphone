/**
 * SVphone Call Manager (v06.00)
 *
 * Orchestrates between signaling layer (blockchain) and media layer (WebRTC).
 * Manages the complete call lifecycle from initiation to termination.
 */

class EventEmitter {
  constructor() {
    this.listeners = new Map()
  }

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
      if (index > -1) callbacks.splice(index, 1)
    }
  }

  emit(eventName, data) {
    const callbacks = this.listeners.get(eventName)
    if (callbacks) {
      callbacks.forEach(cb => {
        try { cb(data) } catch (error) {
          console.error(`[EventEmitter] Error in ${eventName} handler:`, error)
        }
      })
    }
  }
}

class CallManager extends EventEmitter {
  constructor(signaling, peerConnection) {
    super()
    this.signaling = signaling
    this.peerConnection = peerConnection
    this.activeCallSessions = new Map() // Map<callTokenId, CallSession>

    // Bind signaling events
    this.signaling.on('call:initiated', (data) => this.onCallInitiated(data))
    this.signaling.on('call:incoming', (data) => this.onIncomingCall(data))
    this.signaling.on('call:answered', (data) => this.onCallAnswered(data))
    this.signaling.on('call:rejected', (data) => this.onCallRejected(data))

    // Bind peer connection events
    this.peerConnection.on('peer:connected', (data) => this.onPeerConnected(data))
    this.peerConnection.on('peer:connection-failed', (data) => this.onPeerConnectionFailed(data))
    this.peerConnection.on('media:track-received', (data) => this.onRemoteTrackReceived(data))
    this.peerConnection.on('peer:connection-state-changed', ({ peerId, state }) => {
      this.emit('call:log', { msg: `[WebRTC] conn: ${state}`, type: state === 'failed' ? 'error' : 'info' })
    })
    this.peerConnection.on('ice:state-changed', ({ peerId, state }) => {
      this.emit('call:log', { msg: `[ICE] state: ${state}`, type: state === 'failed' ? 'error' : 'info' })
    })
    this.peerConnection.on('ice:gathering-changed', ({ peerId, state }) => {
      this.emit('call:log', { msg: `[ICE] gathering: ${state}`, type: 'info' })
    })
    this.peerConnection.on('ice:pairs-on-failure', ({ peerId, pairs }) => {
      this.emit('call:log', { msg: `[ICE] ${pairs.length} pair(s) tried:`, type: 'error' })
      for (const p of pairs) {
        this.emit('call:log', { msg: `  ${p.state} L:${p.local} → R:${p.remote}`, type: 'error' })
      }
    })
  }

  /**
   * Get the remote peer ID for a session (callee if caller, caller if callee)
   * @private
   */
  _getPeerId(session, callToken) {
    return session.role === 'caller' ? callToken.callee : callToken.caller
  }

  /**
   * Initiate a call — 1-TX path when callee fingerprint is in contacts.
   *
   * 1-TX flow:
   *   1. Derive ICE credentials from session key (deterministic)
   *   2. Create offer with munged ICE (setLocalDescription with derived creds)
   *   3. Wait for ICE gathering (STUN srflx lands in SDP)
   *   4. Build synthetic callee answer (callee fingerprint + derived ICE)
   *   5. setRemoteDescription(syntheticAnswer) — caller ICE agent listens for prflx
   *   6. Broadcast single CALL TX (offer SDP + caller fingerprint)
   *   Callee fires ICE checks → peer-reflexive → DTLS → connected. No ANS token.
   *
   * @param {string} calleeAddress - Recipient's BSV address
   * @param {Object} options - Call options
   * @returns {Promise<CallSession>}
   */
  async initiateCall(calleeAddress, options = {}) {
    try {
      const contactData       = window.contactsStore?.get(calleeAddress) ?? null
      const calleeFingerprint = contactData?.fingerprint ?? null
      const calleeIp          = contactData?.ip ?? null
      const myFingerprint     = this.peerConnection._persistentCertFingerprint ?? null

      if (!myFingerprint) {
        throw new Error('Persistent DTLS cert not yet loaded — try again in a moment.')
      }

      // ── Identity exchange: callee not in contacts ──
      if (!calleeFingerprint) {
        this.emit('call:log', { msg: '[Identity] Callee not in contacts — sending identity exchange...', type: 'info' })

        const sessionKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        const callToken = this.signaling.createCallToken(calleeAddress, sessionKey, {
          codec:   'opus',
          quality: 'hd',
          mediaTypes: ['audio']
        })
        callToken.sdpOffer          = ''   // empty SDP signals identity exchange
        callToken.callerFingerprint = myFingerprint
        callToken.tokenPrefix       = 'CXID'  // contact exchange ID

        const broadcastResult = await this.signaling.broadcastCallToken(callToken, options.mintTokenFn)

        const session = {
          callTokenId:      broadcastResult.callTokenId,
          txId:             broadcastResult.txId,
          calleeAddress,
          role:             'caller',
          status:           'identity-exchange',
          createdAt:        Date.now(),
          sessionKey,
          iceCreds:         null,
          mediaOffer:       null,
          mediaAnswer:      null,
          iceCandidates:    [],
          stats:            {},
          oneTxMode:        false,
          identityExchange: true,
        }

        this.activeCallSessions.set(broadcastResult.callTokenId, session)
        this.emit('call:initiated-session', session)
        this.emit('call:log', { msg: '[Identity] Exchange request sent — waiting for response...', type: 'info' })
        console.log('[CallManager] Identity exchange initiated to:', calleeAddress)

        return session
      }

      // ── 1-TX call: callee fingerprint is in contacts ──

      // Initialize media stream, or re-initialize if video requirement changed
      const needsVideo = options.video !== false
      const hasVideo   = (this.peerConnection.mediaStream?.getVideoTracks().length ?? 0) > 0
      if (!this.peerConnection.mediaStream || needsVideo !== hasVideo) {
        if (this.peerConnection.mediaStream) {
          this.peerConnection.mediaStream.getTracks().forEach(t => t.stop())
          this.peerConnection.mediaStream = null
        }
        await this.peerConnection.initializeMediaStream({
          audio: options.audio !== false,
          video: needsVideo
        })
      }

      // Generate ephemeral session key
      const sessionKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

      // Derive deterministic ICE credentials from session key
      const iceCreds = await window.iceCredentials.deriveAll(sessionKey)
      this.emit('call:log', { msg: `[ICE] Derived: callerUfrag=${iceCreds.callerUfrag} callerPwd=${iceCreds.callerPwd.slice(0,4)}...${iceCreds.callerPwd.slice(-4)}`, type: 'info' })
      this.emit('call:log', { msg: `[ICE] Derived: calleeUfrag=${iceCreds.calleeUfrag} calleePwd=${iceCreds.calleePwd.slice(0,4)}...${iceCreds.calleePwd.slice(-4)}`, type: 'info' })
      this.emit('call:log', { msg: `[ICE] SessionKey hash: ${sessionKey.slice(0,8)}...`, type: 'info' })

      // Create call token
      const callToken = this.signaling.createCallToken(calleeAddress, sessionKey, {
        codec:      options.codec  || 'opus',
        quality:    options.quality || 'hd',
        mediaTypes: options.mediaTypes || (needsVideo ? ['audio', 'video'] : ['audio'])
      })

      // Create offer with munged ICE credentials
      let mediaOffer = null
      try {
        this.emit('call:log', { msg: '[1-TX] Creating munged SDP offer...', type: 'info' })
        await this.peerConnection.createOfferMunged(calleeAddress, iceCreds)
        const finalOffer = await this.peerConnection.waitForIceGathering(calleeAddress)
        mediaOffer = finalOffer
        callToken.sdpOffer        = mediaOffer
        callToken.callerFingerprint = myFingerprint
        this.emit('call:log', { msg: '[1-TX] ✓ Offer ready (ICE gathered)', type: 'info' })
      } catch (error) {
        console.warn('[CallManager] Failed to create munged offer:', error)
        throw error
      }

      // Build synthetic callee answer and set as remote description
      try {
        const syntheticSdp = window.syntheticSdp.build(
          mediaOffer.sdp,
          iceCreds.calleeUfrag,
          iceCreds.calleePwd,
          calleeFingerprint
        )
        await this.peerConnection.setRemoteDescription(calleeAddress, { type: 'answer', sdp: syntheticSdp })
        this.emit('call:log', { msg: '[1-TX] ✓ Synthetic answer set — ICE listening for peer-reflexive', type: 'info' })
      } catch (error) {
        console.warn('[CallManager] Failed to set synthetic remote answer:', error)
        throw error
      }

      // ADF pre-punch: send ICE check to callee's known IP to open ADF NAT hole.
      // The caller's NAT creates a mapping for calleeIp, so when the callee's
      // real ICE checks arrive from that IP, ADF allows them through.
      if (calleeIp) {
        try {
          const punchCandidate = {
            candidate: `candidate:adfpunch 1 UDP 1677729535 ${calleeIp} 3478 typ srflx raddr 0.0.0.0 rport 0`,
            sdpMid: '0',
            sdpMLineIndex: 0,
          }
          await this.peerConnection.addIceCandidate(calleeAddress, punchCandidate)
          this.emit('call:log', { msg: `[ADF] Pre-punch sent to ${calleeIp}:3478`, type: 'info' })
        } catch (e) {
          this.emit('call:log', { msg: `[ADF] Pre-punch skipped: ${e.message}`, type: 'warn' })
        }
      } else {
        this.emit('call:log', { msg: '[ADF] No callee IP in contacts — skipping pre-punch', type: 'warn' })
      }

      // Broadcast single CALL TX
      const broadcastResult = await this.signaling.broadcastCallToken(callToken, options.mintTokenFn)

      // Create session tracking
      const session = {
        callTokenId:  broadcastResult.callTokenId,
        txId:         broadcastResult.txId,
        calleeAddress,
        role:         'caller',
        status:       'initiating',
        createdAt:    Date.now(),
        sessionKey,
        iceCreds,
        mediaOffer,
        mediaAnswer:  null,
        iceCandidates: [],
        stats: {},
        oneTxMode: true,
      }

      this.activeCallSessions.set(broadcastResult.callTokenId, session)
      this.emit('call:initiated-session', session)
      console.log('[CallManager] 1-TX call initiated to:', calleeAddress)

      return session
    } catch (error) {
      console.error('[CallManager] Failed to initiate call:', error)
      this.emit('call:initiation-failed', { error })
      throw error
    }
  }

  /**
   * Handle outgoing call initiated event
   * @private
   */
  onCallInitiated(data) {
    const session = this.activeCallSessions.get(data.callTokenId)
    if (session) {
      session.status = 'ringing'
      this.emit('call:ringing', data)
      console.log('[CallManager] Call ringing:', data.calleeAddress)
    }
  }

  /**
   * Handle incoming call
   * @private
   */
  onIncomingCall(data) {
    // Detect identity exchange: caller sent fingerprint but no SDP
    const callToken = this.signaling.getCallToken(data.callTokenId)
    const sdpContent = typeof callToken?.sdpOffer === 'object' ? callToken?.sdpOffer?.sdp : callToken?.sdpOffer
    const isIdentityExchange = callToken?.callerFingerprint && !sdpContent

    const session = {
      callTokenId: data.callTokenId,
      caller: data.caller,
      role: 'callee',
      status: 'incoming',
      createdAt: Date.now(),
      mediaOffer: null,
      mediaAnswer: null,
      iceCandidates: [],
      stats: {},
      identityExchange: isIdentityExchange,
    }

    this.activeCallSessions.set(data.callTokenId, session)
    this.emit('call:incoming-session', session)
    console.log('[CallManager] Incoming', isIdentityExchange ? 'identity exchange' : 'call', 'from:', data.caller)
  }

  /**
   * Accept incoming call — 0-TX callee path.
   *
   * 1-TX flow (callerFingerprint present in CALL token):
   *   1. Derive ICE credentials from caller's session key
   *   2. createAnswerMunged() — setRemoteDescription(offer) + munge ICE + setLocalDescription
   *   3. Wait for ICE gathering
   *   4. Inject caller's public IP:port as srflx candidates → ICE starts checking immediately
   *   5. ICE peer-reflexive → DTLS → connected. NO ANS TOKEN SENT.
   *
   * Fallback (no callerFingerprint, old 2-TX caller):
   *   Same ICE setup, but also broadcasts ANS token via broadcastAnswerFn.
   *
   * @param {string} callTokenId - Call token ID
   * @param {Object} options     - { audio, video, broadcastAnswerFn }
   * @returns {Promise<CallSession>}
   */
  async acceptCall(callTokenId, options = {}) {
    try {
      const session = this.activeCallSessions.get(callTokenId)
      if (!session) throw new Error(`Call session not found: ${callTokenId}`)

      const callToken = this.signaling.getCallToken(callTokenId)
      const iceLog    = (msg, type = 'info') => this.emit('call:log', { msg, type })

      // ── Identity exchange: caller sent fingerprint but no SDP ──
      const sdpContent = typeof callToken?.sdpOffer === 'object' ? callToken?.sdpOffer?.sdp : callToken?.sdpOffer
      const isIdentityExchange = callToken?.callerFingerprint && !sdpContent
      if (isIdentityExchange) {
        // Save caller's identity to contacts (include IP for ADF pre-punch)
        window.contactsStore?.save(callToken.caller, callToken.callerFingerprint, callToken.senderIp4 || null)
        iceLog(`[Identity] Saved contact for ${callToken.caller}`, 'success')

        // Broadcast ANS with our fingerprint
        const myFingerprint = this.peerConnection._persistentCertFingerprint ?? null
        if (myFingerprint && options.broadcastAnswerFn) {
          try {
            await options.broadcastAnswerFn(callTokenId, callToken.caller, {
              sdpAnswer:        '',
              senderIp:         this.signaling.myIp || '0.0.0.0',
              senderIp4:        this.signaling.myIp4 ?? null,
              senderIp6:        this.signaling.myIp6 ?? null,
              senderPort:       this.signaling.myPort || 0,
              sessionKey:       callToken.sessionKey || '',
              codec:            'opus',
              quality:          'hd',
              mediaTypes:       ['audio'],
              callee:           this.signaling.myAddress,
              calleeFingerprint: myFingerprint,
            })
            iceLog('[Identity] Your identity sent back to caller', 'success')
          } catch (err) {
            console.warn('[CallManager] Identity ANS broadcast failed:', err.message)
          }
        }

        session.status = 'ended'
        session.identityExchange = true
        this.emit('call:identity-exchanged', {
          callTokenId,
          address:     callToken.caller,
          fingerprint: callToken.callerFingerprint,
          role:        'callee',
        })
        console.log('[CallManager] Identity exchange accepted — caller fingerprint saved')
        return session
      }

      // ── Normal call accept flow ──

      if (!this.peerConnection.mediaStream) {
        await this.peerConnection.initializeMediaStream({
          audio: options.audio !== false,
          video: options.video !== false
        })
      }

      session.status = 'accepting'
      this.signaling.acceptCall(callTokenId, {})

      if (!callToken?.sdpOffer) {
        session.status = 'connecting'
        this.emit('call:accepted-session', session)
        return session
      }

      const offerSdp    = typeof callToken.sdpOffer === 'object' ? callToken.sdpOffer.sdp : callToken.sdpOffer
      const oneTxMode   = !!callToken.callerFingerprint

      iceLog(`[Accept] ${oneTxMode ? '1-TX mode (no ANS token)' : '2-TX mode (ANS token required)'}`)

      try {
        // Derive ICE credentials from the caller's session key
        const iceCreds = await window.iceCredentials.deriveAll(callToken.sessionKey)
        iceLog(`[Accept] Derived ICE creds: callee=${iceCreds.calleeUfrag} caller=${iceCreds.callerUfrag}`)
        iceLog(`[Accept] SessionKey hash: ${(callToken.sessionKey || '').slice(0,8)}...`)

        // Create answer with persistent cert + derived ICE credentials
        const answer     = await this.peerConnection.createAnswerMunged(callToken.caller, offerSdp, iceCreds)
        const finalAnswer = await this.peerConnection.waitForIceGathering(callToken.caller)
        session.mediaAnswer = finalAnswer || answer

        iceLog(`[Accept] ✓ Answer ready, injecting caller public IP candidates...`)

        // Inject caller's public IP as srflx candidates so ICE checks start immediately
        if (callToken.senderIp4 || callToken.senderIp6) {
          const pubCandidates = this.peerConnection._buildPublicIpCandidates(
            offerSdp,
            callToken.senderIp4 ?? null,
            callToken.senderIp6 ?? null,
            iceLog
          )
          for (const c of pubCandidates) {
            this.peerConnection.addIceCandidate(callToken.caller, c).catch(() => {})
          }
        }

        if (oneTxMode) {
          // 1-TX: ICE fires checks to caller → peer-reflexive → DTLS → connected
          iceLog('[Accept] ✓ 1-TX: ICE active. Callee firing checks to caller — waiting for peer-reflexive...')
        } else {
          // 2-TX fallback: broadcast ANS token so caller can setRemoteDescription
          if (options.broadcastAnswerFn) {
            try {
              const answerSdp = session.mediaAnswer?.sdp || answer.sdp
              iceLog('[Accept] Broadcasting ANS token to caller (2-TX fallback)...')
              await this.signaling.broadcastCallAnswer(
                callTokenId,
                callToken.caller,
                {
                  sdpAnswer:  answerSdp,
                  senderIp:   this.signaling.myIp,
                  senderIp4:  this.signaling.myIp4 ?? null,
                  senderIp6:  this.signaling.myIp6 ?? null,
                  senderPort: this.signaling.myPort,
                  sessionKey: callToken.sessionKey,
                  codec:      callToken.codec,
                  quality:    callToken.quality,
                  mediaTypes: callToken.mediaTypes,
                  callee:     this.signaling.myAddress,
                },
                options.broadcastAnswerFn
              )
              iceLog('[Accept] ✓ ANS token sent')
            } catch (err) {
              console.warn('[CallManager] ANS broadcast failed:', err.message)
            }
          }
        }
      } catch (error) {
        console.warn('[CallManager] WebRTC answer setup failed:', error)
      }

      session.status = 'connecting'
      this.emit('call:accepted-session', session)
      console.log('[CallManager] Accepted call:', callTokenId)
      return session
    } catch (error) {
      console.error('[CallManager] Failed to accept call:', error)
      this.emit('call:acceptance-failed', { callTokenId, error })
      throw error
    }
  }

  /**
   * Reject incoming call
   */
  async rejectCall(callTokenId, reason = 'user-declined') {
    try {
      this.signaling.rejectCall(callTokenId, reason)

      const session = this.activeCallSessions.get(callTokenId)
      if (session) {
        session.status = 'rejected'
      }

      this.emit('call:rejected-session', { callTokenId, reason })
      console.log('[CallManager] Rejected call:', callTokenId)
    } catch (error) {
      console.error('[CallManager] Failed to reject call:', error)
      throw error
    }
  }

  /**
   * Handle call answered event
   * @private
   */
  onCallAnswered(data) {
    let session = this.activeCallSessions.get(data.callTokenId)

    // Fallback: answer inscription txId ≠ call inscription txId. If direct lookup
    // misses (e.g., session stored under call txId), find caller session by callee address.
    if (!session && data.callee) {
      for (const [, s] of this.activeCallSessions) {
        if (s.role === 'caller' && s.calleeAddress === data.callee) {
          session = s
          break
        }
      }
    }

    if (session) {
      // Identity exchange: save callee's fingerprint and end
      if (session.identityExchange && data.callerFingerprint) {
        window.contactsStore?.save(session.calleeAddress, data.callerFingerprint, data.calleeIp4 || null)
        session.status = 'ended'
        this.emit('call:identity-exchanged', {
          callTokenId: session.callTokenId,
          address:     session.calleeAddress,
          fingerprint: data.callerFingerprint,
          role:        'caller',
        })
        this.emit('call:log', { msg: `[Identity] Contact saved for ${session.calleeAddress}! You can now call them.`, type: 'success' })
        console.log('[CallManager] Identity exchange complete — callee fingerprint saved')
        return
      }

      session.status = 'answered'
      this.emit('call:answered-session', data)
      console.log('[CallManager] Call answered')
    }
  }

  /**
   * Handle call rejected event
   * @private
   */
  onCallRejected(data) {
    const session = this.activeCallSessions.get(data.callTokenId)
    if (session) {
      session.status = 'rejected'
      this.emit('call:rejected-session', data)
    }
  }

  /**
   * Add ICE candidate to peer connection
   */
  async addIceCandidate(callTokenId, candidate) {
    try {
      const session = this.activeCallSessions.get(callTokenId)
      if (!session) {
        throw new Error(`Call session not found: ${callTokenId}`)
      }

      const callToken = this.signaling.getCallToken(callTokenId)
      const peerId = this._getPeerId(session, callToken)

      await this.peerConnection.addIceCandidate(peerId, candidate)
      session.iceCandidates.push(candidate)
    } catch (error) {
      console.error('[CallManager] Failed to add ICE candidate:', error)
    }
  }

  /**
   * Handle peer connected
   * @private
   */
  onPeerConnected(data) {
    // Find session by peer ID
    let session = null
    for (const [callTokenId, sess] of this.activeCallSessions) {
      const callToken = this.signaling.getCallToken(callTokenId)
      if (callToken) {
        const peerId = this._getPeerId(sess, callToken)
        if (peerId === data.peerId) {
          session = sess
          break
        }
      }
    }

    if (session) {
      console.debug('[CallManager] onPeerConnected: Found session, setting status to connected')
      session.status = 'connected'
      session.connectedAt = Date.now()

      // Start collecting statistics
      console.debug('[CallManager] onPeerConnected: Starting stats monitoring')
      this.startStatsMonitoring(session.callTokenId)

      console.debug('[CallManager] onPeerConnected: About to emit call:connected event')
      this.emit('call:connected', {
        callTokenId: session.callTokenId,
        timestamp: Date.now()
      })
      console.debug('[CallManager] onPeerConnected: Emitted call:connected event')

      console.log('[CallManager] Peer connected')
    } else {
      console.error('[CallManager] onPeerConnected: NO SESSION FOUND! This is the problem!')
    }
  }

  /**
   * Handle peer connection failed
   * @private
   */
  onPeerConnectionFailed(data) {
    console.error('[CallManager] Peer connection failed:', data.peerId)
    this.emit('call:connection-failed', data)
  }

  /**
   * Handle remote media track received
   * @private
   */
  onRemoteTrackReceived(data) {
    this.emit('media:remote-track', data)
    console.log('[CallManager] Received remote', data.track.kind, 'track')
  }

  /**
   * Start monitoring call statistics
   * @private
   */
  startStatsMonitoring(callTokenId) {
    const session = this.activeCallSessions.get(callTokenId)
    if (!session) return

    const callToken = this.signaling.getCallToken(callTokenId)
    const peerId = this._getPeerId(session, callToken)

    const monitorInterval = setInterval(async () => {
      if (session.status !== 'connected') {
        clearInterval(monitorInterval)
        return
      }

      try {
        const stats = await this.peerConnection.getStats(peerId)
        if (stats) {
          session.stats = {
            ...session.stats,
            lastUpdated: Date.now(),
            ...stats
          }
          this.emit('call:stats-updated', {
            callTokenId: callTokenId,
            stats: stats
          })
        }
      } catch (error) {
        console.warn('[CallManager] Failed to collect stats:', error)
      }
    }, 5000) // Collect stats every 5 seconds

    session.statsMonitor = monitorInterval
  }

  /**
   * End call
   *
   * @param {string} callTokenId - Call token ID
   * @param {Object} options - End options
   */
  async endCall(callTokenId, options = {}) {
    try {
      const session = this.activeCallSessions.get(callTokenId)
      if (!session) {
        throw new Error(`Call session not found: ${callTokenId}`)
      }

      // Stop stats monitoring
      if (session.statsMonitor) {
        clearInterval(session.statsMonitor)
      }

      // Close peer connection
      const callToken = this.signaling.getCallToken(callTokenId)
      if (callToken) {
        const peerId = this._getPeerId(session, callToken)
        this.peerConnection.closePeerConnection(peerId)
      }

      // Update signaling
      const duration = session.connectedAt ? Date.now() - session.connectedAt : 0
      this.signaling.endCall(callTokenId, {
        duration: duration,
        quality: session.stats
      })

      // Update session
      session.status = 'ended'
      session.endedAt = Date.now()

      this.emit('call:ended-session', {
        callTokenId: callTokenId,
        duration: duration,
        stats: session.stats
      })

      console.log('[CallManager] Ended call:', callTokenId, `(${duration}ms)`)
    } catch (error) {
      console.error('[CallManager] Failed to end call:', error)
      throw error
    }
  }

  /**
   * Get call session
   */
  getSession(callTokenId) {
    return this.activeCallSessions.get(callTokenId)
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    return Array.from(this.activeCallSessions.values())
  }

  /**
   * Get local media stream
   */
  getLocalMediaStream() {
    return this.peerConnection.mediaStream
  }

  /**
   * Get remote media stream
   */
  getRemoteMediaStream(callTokenId) {
    const session = this.activeCallSessions.get(callTokenId)
    if (!session) return null

    const callToken = this.signaling.getCallToken(callTokenId)
    const peerId = this._getPeerId(session, callToken)
    const pc = this.peerConnection.getPeerConnection(peerId)

    if (pc) {
      const receivers = pc.getReceivers()
      if (receivers.length > 0) {
        const tracks = receivers.map(r => r.track)
        return new MediaStream(tracks)
      }
    }

    return null
  }

}

// Export for browser
if (typeof window !== 'undefined') {
  window.CallManager = CallManager
}

// Export for Node.js/modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CallManager
}
