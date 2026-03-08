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

      // Create offer with munged ICE credentials + DataChannel for punch signaling
      let mediaOffer = null
      try {
        this.emit('call:log', { msg: '[1-TX] Creating munged SDP offer...', type: 'info' })

        // Ensure PC exists so we can add a DataChannel before the offer is created
        if (!this.peerConnection.getPeerConnection(calleeAddress)) {
          this.peerConnection.createPeerConnection(calleeAddress, this.peerConnection._persistentCert)
        }
        const callerPc = this.peerConnection.getPeerConnection(calleeAddress)
        const punchCh = callerPc.createDataChannel('sv-punch')
        this._setupPunchChannel(punchCh, 'caller')

        await this.peerConnection.createOfferMunged(calleeAddress, iceCreds)
        const finalOffer = await this.peerConnection.waitForIceGathering(calleeAddress)
        mediaOffer = finalOffer
        callToken.sdpOffer        = mediaOffer
        callToken.callerFingerprint = myFingerprint

        // Extract caller's srflx port from gathered SDP so callee knows where to punch
        const srflxMatch = (mediaOffer.sdp || '').match(/(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+typ\s+srflx/)
        if (srflxMatch) {
          callToken.senderPort = parseInt(srflxMatch[2], 10)
          this.emit('call:log', { msg: `[1-TX] ✓ srflx port: ${srflxMatch[2]} (included in CALL token for callee punch target)`, type: 'info' })
        }

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

      // Broadcast CALL TX — no spray yet. Contact IP may be stale.
      // Caller waits for PORT token with callee's fresh IP:port before spraying.
      const broadcastResult = await this.signaling.broadcastCallToken(callToken, options.mintTokenFn)
      this.emit('call:log', { msg: '[1-TX] ✓ CALL TX broadcast — awaiting PORT token for callee IP:port', type: 'info' })

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

    // For 1-TX calls with caller's IP, start ICE pre-punch IMMEDIATELY
    // (before user clicks Accept) so both sides punch simultaneously.
    if (!isIdentityExchange && sdpContent && callToken?.senderIp4) {
      this._startPrePunch(data.callTokenId, callToken).catch(err => {
        console.warn('[CallManager] Pre-punch failed:', err)
        this.emit('call:log', { msg: `[PrePunch] Failed: ${err.message}`, type: 'error' })
      })
    }

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

      session.status = 'accepting'
      this.signaling.acceptCall(callTokenId, {})

      // ── Pre-punch path: PC already exists and is punching ──
      if (session.prePunchActive) {
        const rtcPc = this.peerConnection.getPeerConnection(callToken.caller)
        if (rtcPc && rtcPc.connectionState !== 'failed' && rtcPc.connectionState !== 'closed') {
          iceLog('[Accept] Pre-punch PC active — adding media tracks to existing connection')

          // Get media permissions and add tracks to the existing PC
          if (!this.peerConnection.mediaStream) {
            await this.peerConnection.initializeMediaStream({
              audio: options.audio !== false,
              video: options.video !== false,
            })
          }
          if (this.peerConnection.mediaStream) {
            this.peerConnection.mediaStream.getTracks().forEach(track => {
              rtcPc.addTrack(track, this.peerConnection.mediaStream)
            })
            iceLog('[Accept] ✓ Media tracks added to pre-punched connection')
          }

          // If already connected during pre-punch, transition immediately
          if (rtcPc.connectionState === 'connected') {
            session.status = 'connected'
            session.connectedAt = Date.now()
            this.startStatsMonitoring(callTokenId)
            this.emit('call:connected', { callTokenId, timestamp: Date.now() })
            iceLog('[Accept] ✓ Already connected from pre-punch!', 'success')
          } else {
            session.status = 'connecting'
          }

          this.emit('call:accepted-session', session)
          return session
        }
        // Pre-punch PC failed — fall through to normal flow
        iceLog('[Accept] Pre-punch PC failed, falling back to normal flow')
        session.prePunchActive = false
      }

      // ── Standard flow (no pre-punch or pre-punch failed) ──

      if (!this.peerConnection.mediaStream) {
        await this.peerConnection.initializeMediaStream({
          audio: options.audio !== false,
          video: options.video !== false
        })
      }

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

          // Targeted callee spray to caller's known srflx port ±20
          const callerIp4 = callToken.senderIp4 ?? null
          const callerPunchPort = callToken.senderPort || null
          if (callerIp4 && callerPunchPort) {
            await this._injectPortSpray(callToken.caller, callerIp4, { knownPort: callerPunchPort, batch: 0 })

            let sprayBatch = 1
            this._calleePunchInterval = setInterval(async () => {
              const pc = this.peerConnection.getPeerConnection(callToken.caller)
              if (!pc || pc.connectionState === 'connected' || pc.connectionState === 'closed') {
                clearInterval(this._calleePunchInterval)
                this._calleePunchInterval = null
                if (pc?.connectionState === 'connected') {
                  iceLog('[Spray] Callee connected!', 'success')
                }
                return
              }
              await this._injectPortSpray(callToken.caller, callerIp4, { knownPort: callerPunchPort, batch: sprayBatch++ })
            }, 3000)
          }
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

        // Clean up pre-punch PC if active
        if (session.prePunchActive) {
          if (this._calleePunchInterval) {
            clearInterval(this._calleePunchInterval)
            this._calleePunchInterval = null
          }
          const callToken = this.signaling.getCallToken(callTokenId)
          if (callToken) {
            this.peerConnection.closePeerConnection(callToken.caller)
          }
          session.prePunchActive = false
        }
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

      // Port announcement (no SDP, just callee's srflx IP:port from STUN/host)
      const calleePort = data.calleePort
      const calleeIp   = data.calleeIp4 || data.calleeIp6 || null
      if (!data.sdpAnswer && calleePort && calleeIp) {
        this.emit('call:log', { msg: `[PORT] Callee port received: ${calleeIp}:${calleePort} — starting targeted spray`, type: 'success' })

        // Start targeted ±20 spray using fresh IP:port from PORT token.
        // Spray for up to 2 min — ISP TX propagation can delay the other side by 60s+.
        this._injectPortSpray(session.calleeAddress, calleeIp, { knownPort: calleePort, batch: 0 })

        let sprayBatch = 1
        const sprayStart = Date.now()
        this._callerPunchInterval = setInterval(async () => {
          const pc = this.peerConnection.getPeerConnection(session.calleeAddress)
          const elapsed = Date.now() - sprayStart
          if (!pc || pc.connectionState === 'connected' || pc.connectionState === 'closed' || elapsed > 120000) {
            clearInterval(this._callerPunchInterval)
            this._callerPunchInterval = null
            if (pc?.connectionState === 'connected') {
              this.emit('call:log', { msg: '[PORT] Caller connected!', type: 'success' })
            } else if (elapsed > 120000) {
              this.emit('call:log', { msg: '[Spray] Caller spray timed out after 2 min', type: 'warn' })
            }
            return
          }
          await this._injectPortSpray(session.calleeAddress, calleeIp, { knownPort: calleePort, batch: sprayBatch++ })
        }, 3000)

        console.log('[CallManager] Port announcement received — upgraded to targeted spray')
        return  // Don't emit call:answered-session for port announcements
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
      // If pre-punch connected before user accepted, defer the transition.
      // acceptCall() will handle the connected state when the user clicks Accept.
      if (session.prePunchActive && session.status === 'incoming') {
        session.preConnected = true
        this.emit('call:log', { msg: '[PrePunch] ICE connected before user accepted — waiting for Accept', type: 'success' })
        console.log('[CallManager] Pre-punch connected, awaiting user accept')
        return
      }

      console.debug('[CallManager] onPeerConnected: Found session, setting status to connected')
      session.status = 'connected'
      session.connectedAt = Date.now()

      // Start collecting statistics
      this.startStatsMonitoring(session.callTokenId)

      this.emit('call:connected', {
        callTokenId: session.callTokenId,
        timestamp: Date.now()
      })

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
   * Inject ICE candidates targeting ±20 ports around a known remote port.
   * Opens NAT mappings so the peer's actual port is likely covered.
   * @private
   * @param {string} peerId   - Remote peer address
   * @param {string} remoteIp - Remote public IP
   * @param {Object} options  - { knownPort, batch }
   * @returns {Promise<number>} candidates injected
   */
  async _injectPortSpray(peerId, remoteIp, options = {}) {
    const { knownPort = null, batch = 0 } = options
    const iceLog = (msg, type = 'info') => this.emit('call:log', { msg, type })
    const ports = []

    if (knownPort) {
      for (let p = knownPort - 20; p <= knownPort + 20; p++) {
        if (p > 0 && p <= 65535) ports.push(p)
      }
    } else {
      // Fallback: VoIP range
      for (let p = 3478; p <= 3497; p++) ports.push(p)
    }

    let ok = 0
    const tasks = ports.map((port, i) =>
      this.peerConnection.addIceCandidate(peerId, {
        candidate: `candidate:spray${batch}_${i} 1 UDP ${1677729535 - i} ${remoteIp} ${port} typ srflx raddr 0.0.0.0 rport 0`,
        sdpMid: '0',
        sdpMLineIndex: 0,
      }).then(() => ok++).catch(() => {})
    )
    await Promise.all(tasks)

    iceLog(`[Spray] #${batch} ${ok}/${ports.length} → ${remoteIp}:${ports[0]}-${ports[ports.length - 1]}`)
    return ok
  }

  /**
   * Set up a DataChannel for punch-hit/ack signaling.
   * When ICE connects and the channel opens, both sides exchange
   * confirmation messages so they know the exact addresses that worked.
   * @private
   */
  _setupPunchChannel(channel, role) {
    const iceLog = (msg, type = 'info') => this.emit('call:log', { msg, type })
    channel.onopen = () => {
      iceLog(`[PUNCH] DataChannel open (${role}) — sending PUNCH_HIT`, 'success')
      channel.send(JSON.stringify({ type: 'PUNCH_HIT', role, ts: Date.now() }))
    }
    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'PUNCH_HIT') {
          iceLog(`[PUNCH] Received PUNCH_HIT from ${msg.role}`, 'success')
          channel.send(JSON.stringify({ type: 'PUNCH_ACK', role, ts: Date.now() }))
        } else if (msg.type === 'PUNCH_ACK') {
          iceLog('[PUNCH] Received PUNCH_ACK — connection confirmed!', 'success')
        }
      } catch { /* ignore malformed messages */ }
    }
    channel.onerror = (e) => iceLog(`[PUNCH] DataChannel error: ${e.message || e}`, 'error')
    this._punchChannel = channel
  }

  /**
   * Start ICE pre-punch immediately when a 1-TX CALL TX arrives.
   * Creates the PeerConnection and begins punching to the caller's IP
   * BEFORE the user clicks Accept — so both sides punch simultaneously.
   * The same PC is reused when acceptCall() runs.
   * @private
   */
  async _startPrePunch(callTokenId, callToken) {
    const iceLog = (msg, type = 'info') => this.emit('call:log', { msg, type })
    const offerSdp = typeof callToken.sdpOffer === 'object' ? callToken.sdpOffer.sdp : callToken.sdpOffer

    // Derive ICE credentials from the caller's session key
    const iceCreds = await window.iceCredentials.deriveAll(callToken.sessionKey)
    iceLog(`[PrePunch] Derived ICE creds: callee=${iceCreds.calleeUfrag}`)

    // Create PC WITH STUN for port discovery (null = use default STUN servers)
    const answer   = await this.peerConnection.createAnswerMunged(
      callToken.caller, offerSdp, iceCreds, { iceServers: null }
    )
    const finalAns = await this.peerConnection.waitForIceGathering(callToken.caller)

    const session = this.activeCallSessions.get(callTokenId)
    const rtcPc = this.peerConnection.getPeerConnection(callToken.caller)

    // Listen for srflx candidate (STUN port discovery)
    if (rtcPc) {
      let srflxAnnounced = false
      const announceSrflx = (ip, port, source) => {
        if (srflxAnnounced) return
        srflxAnnounced = true
        iceLog(`[PrePunch] STUN discovered (${source}): ${ip}:${port}`, 'success')
        if (session) session.calleeSrflx = { ip, port }
        this.emit('call:port-discovered', {
          callTokenId,
          callerAddress: callToken.caller,
          sessionKey: callToken.sessionKey,
          ip,
          port,
        })
      }

      // Async listener — catches srflx even if STUN responds after gathering timeout
      rtcPc.addEventListener('icecandidate', (event) => {
        if (!event.candidate) return
        const cand = event.candidate.candidate
        if (cand.includes('typ srflx')) {
          const parts = cand.split(' ')
          const ip = parts[4]
          const port = parseInt(parts[5])
          if (ip && port) announceSrflx(ip, port, 'event')
        }
      })

      // Also check gathered SDP (in case STUN completed before listener was added)
      // Note: Chrome uses lowercase "udp", so match case-insensitively with \w+
      const gatheredSdp = (finalAns?.sdp || answer?.sdp || '')
      const srflxMatch = gatheredSdp.match(/(\d+\.\d+\.\d+\.\d+)\s+(\d+)\s+typ\s+srflx/)
      if (srflxMatch) announceSrflx(srflxMatch[1], parseInt(srflxMatch[2]), 'SDP')

      // Fallback: if no srflx found, use host candidate port with our known public IP.
      // Covers two cases:
      //  1. Machine has public IP on interface → browser deduplicates srflx with host (RFC 8445)
      //  2. STUN didn't respond → only host candidates available
      // Chrome uses mDNS hostnames (xxx.local) instead of IPs, so match any address with \S+
      if (!srflxAnnounced) {
        const myPublicIp = this.signaling.myIp4
        if (myPublicIp) {
          // Try matching our public IP directly in host candidates
          const escapedIp = myPublicIp.replace(/\./g, '\\.')
          const hostMatch = gatheredSdp.match(new RegExp(
            `(?:^|\\n)a=candidate:\\S+\\s+1\\s+\\w+\\s+\\d+\\s+${escapedIp}\\s+(\\d+)\\s+typ\\s+host`
          ))
          if (hostMatch) {
            announceSrflx(myPublicIp, parseInt(hostMatch[1]), 'host-public')
          } else {
            // Last resort: use any host candidate's port (may be mDNS hostname)
            const anyHostMatch = gatheredSdp.match(
              /a=candidate:\S+\s+1\s+\w+\s+\d+\s+(\S+)\s+(\d+)\s+typ\s+host/
            )
            if (anyHostMatch) {
              const hostPort = parseInt(anyHostMatch[2])
              iceLog(`[PrePunch] No srflx — using public IP + host port: ${myPublicIp}:${hostPort}`)
              announceSrflx(myPublicIp, hostPort, 'host-fallback')
            } else {
              iceLog(`[PrePunch] No candidates found in SDP (${gatheredSdp.length}B)`, 'warn')
            }
          }
        } else {
          iceLog('[PrePunch] No public IP detected — cannot announce port', 'warn')
        }
      }

      // DataChannel handler for incoming punch channel from caller
      rtcPc.ondatachannel = (event) => {
        iceLog('[PrePunch] DataChannel received from caller')
        this._setupPunchChannel(event.channel, 'callee')
      }
    }

    // Inject caller's public IP as srflx candidates
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

    // Save caller spray target — spray deferred until PORT TX is in mempool
    // so both sides punch simultaneously (caller waits for PORT TX too).
    const callerIp4 = callToken.senderIp4 ?? null
    const callerPort = callToken.senderPort || null

    // Update session so acceptCall() can reuse this PC
    if (session) {
      session.prePunchActive = true
      session.iceCreds = iceCreds
      session.mediaAnswer = finalAns || answer
      session.callerSprayTarget = { ip: callerIp4, port: callerPort, callerPeerId: callToken.caller }
    }
    iceLog('[PrePunch] ICE active — awaiting PORT TX broadcast before spraying')
  }

  /**
   * Start callee spray after PORT TX has been broadcast to mempool.
   * Called by phone-controller after broadcastCallAnswer() completes.
   * Both sides spray simultaneously — caller starts when it sees the PORT token,
   * callee starts here after broadcasting it.
   * @param {string} callTokenId - Call token ID
   */
  startCalleeSpray(callTokenId) {
    const session = this.activeCallSessions.get(callTokenId)
    if (!session?.callerSprayTarget) {
      this.emit('call:log', { msg: '[Spray] No caller spray target saved — skipping callee spray', type: 'warn' })
      return
    }

    const { ip, port, callerPeerId } = session.callerSprayTarget
    if (!ip || !port) {
      this.emit('call:log', { msg: '[Spray] Caller IP/port missing — skipping callee spray', type: 'warn' })
      return
    }

    this.emit('call:log', { msg: `[Spray] PORT TX in mempool — starting callee spray to ${ip}:${port} (up to 2 min)`, type: 'success' })

    // Spray for up to 2 min — ISP TX propagation can delay the other side by 60s+.
    this._injectPortSpray(callerPeerId, ip, { knownPort: port, batch: 0 })

    let sprayBatch = 1
    const sprayStart = Date.now()
    this._calleePunchInterval = setInterval(async () => {
      const pc = this.peerConnection.getPeerConnection(callerPeerId)
      const elapsed = Date.now() - sprayStart
      if (!pc || pc.connectionState === 'connected' || pc.connectionState === 'closed' || elapsed > 120000) {
        clearInterval(this._calleePunchInterval)
        this._calleePunchInterval = null
        if (pc?.connectionState === 'connected') {
          this.emit('call:log', { msg: '[Spray] Callee connected!', type: 'success' })
        } else if (elapsed > 120000) {
          this.emit('call:log', { msg: '[Spray] Callee spray timed out after 2 min', type: 'warn' })
        }
        return
      }
      await this._injectPortSpray(callerPeerId, ip, { knownPort: port, batch: sprayBatch++ })
    }, 3000)
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

      // Stop ADF punch intervals and close punch channel
      if (this._callerPunchInterval) {
        clearInterval(this._callerPunchInterval)
        this._callerPunchInterval = null
      }
      if (this._punchChannel) {
        try { this._punchChannel.close() } catch {}
        this._punchChannel = null
      }
      if (this._calleePunchInterval) {
        clearInterval(this._calleePunchInterval)
        this._calleePunchInterval = null
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
