/**
 * SVphone Phone Controller Layer (v07.00)
 *
 * Handles:
 * - Application orchestration and initialization
 * - Background polling coordination
 * - Event binding and listener management
 * - State synchronization
 */

class PhoneController {
    constructor() {
        // Core modules
        this.callManager = null
        this.signaling = null
        this.peerConnection = null
        this.codecs = null
        this.quality = null
        this.security = null
        this.micTester = null
        this.cameraTester = null

        // UI layer
        this.ui = null

        // Event handlers
        this.callHandlers = null
        this.micHandlers = null
        this.cameraHandlers = null

        // Call state
        this.currentCallToken = null
        this.currentRole = null
        this.calleeConnectionData = null
        this.isMediaActive = false
        this.callStartTime = null
        this.durationInterval = null
        // Initialize call token manager
        this.callTokenManager = null

        // UDP port for direct P2P communication
        this.assignedUdpPort = null

        // Screen Wake Lock (prevents screen sleep dropping the call)
        this.wakeLock = null

        this.init()
    }

    /**
     * Initialize application on startup
     */
    async init() {
        try {
            console.log('[SVphone] Initializing controller...')

            // Initialize UI layer
            this.ui = new PhoneUI()
            this.ui.log('Initializing SVphone v07.00...', 'info')

            // Sync wallet data from shared state (wallet.html)
            try {
                this.syncWalletData()
            } catch (e) {
                this.ui.log(`⚠️  Wallet sync error: ${e.message}`, 'error')
            }

            // Load last called address (phone UI local history)
            try {
                this.loadLastCalled()
            } catch (e) {
                this.ui.log(`⚠️  Last called load error: ${e.message}`, 'error')
            }

            // Auto-detect IP and generate ephemeral port
            try {
                await this.autoDetectNetworkConfig()
            } catch (e) {
                this.ui.log(`⚠️  Network config error: ${e.message}`, 'error')
            }

            // Create all component modules
            this.signaling = new CallSignaling()
            // Apply IPs detected before signaling was created
            this.signaling.myIp4 = this._detectedIp4 ?? null
            this.signaling.myIp6 = this._detectedIp6 ?? null
            this.peerConnection = new PeerConnection({
                // Direct P2P with no centralized STUN servers
                // Uses mDNS discovery and standard VoIP ports (3478-3497)
                // iceServers: [] (empty - default in PeerConnection)
            })
            this.callManager = new CallManager(this.signaling, this.peerConnection)
            this.codecs = new CodecNegotiation()
            this.quality = new QualityAdaptation()
            this.security = new MediaSecurity()
            this.micTester = new MicrophoneTester((msg, type) => this.ui.log(msg, type))
            this.cameraTester = new CameraTester((msg, type) => this.ui.log(msg, type))

            // Initialize call token manager
            if (window.CallTokenManager) {
                this.callTokenManager = new CallTokenManager((msg, type) => this.ui.log(msg, type))
                console.debug('[INIT] CallTokenManager initialized')
            }

            // Initialize 1-TX identity modules
            if (window.DtlsCertStore && window.ContactsStore && window.IceCredentials && window.SyntheticSdp) {
                this.dtlsCertStore = new DtlsCertStore()
                this.contactsStore = new ContactsStore()

                window.iceCredentials = new IceCredentials()
                window.syntheticSdp   = new SyntheticSdp()
                window.contactsStore  = this.contactsStore

                // Load (or generate) the persistent DTLS certificate asynchronously
                this.dtlsCertStore.getOrCreate().then(cert => {
                    this.peerConnection._persistentCert            = cert
                    this.peerConnection._persistentCertFingerprint = this.dtlsCertStore.getFingerprint(cert)
                    const fp = this.peerConnection._persistentCertFingerprint
                    this.ui.log(`✓ DTLS identity: ...${fp.slice(-20)}`, 'success')
                    // Persist fingerprint and identity string in localStorage
                    localStorage.setItem('svphone_my_fingerprint', fp)
                    const addr = document.getElementById('myAddress')?.value || localStorage.getItem('svphone_wallet_address') || ''
                    if (addr) {
                        const identity = this.contactsStore.format(addr, fp, this._detectedIp4 || null)
                        localStorage.setItem('svphone_my_identity', identity)
                        const identityEl = document.getElementById('myIdentityStr')
                        if (identityEl) identityEl.value = identity
                    }
                    this.refreshContactsList()
                }).catch(e => {
                    this.ui.log(`⚠️  DTLS cert error: ${e.message}`, 'warning')
                })
                console.debug('[INIT] 1-TX identity modules initialized')
            }

            // Create handler instances with references to this controller and UI
            this.callHandlers = new CallHandlers(this, this.ui)
            this.micHandlers = new MicrophoneTestHandlers(this, this.ui)
            this.cameraHandlers = new CameraTestHandlers(this, this.ui)

            // Bind event listeners
            this.bindEvents()

            // Diagnostic: Check if calleeAddress field is accessible
            const calleeField = document.getElementById('calleeAddress')
            if (calleeField) {
                console.debug('[DIAG] calleeAddress field found:', {
                    id: calleeField.id,
                    type: calleeField.type,
                    disabled: calleeField.disabled,
                    readonly: calleeField.readOnly,
                    visible: calleeField.offsetParent !== null,
                    value: calleeField.value || '(empty)'
                })
            } else {
                console.error('[DIAG] calleeAddress field NOT FOUND in DOM!')
            }

            // Start background polling for incoming calls
            try {
                this.startBackgroundPolling()
            } catch (e) {
                this.ui.log(`⚠️  Could not start background polling: ${e.message}`, 'warning')
            }

            this.ui.log('SVphone initialized successfully', 'success')
        } catch (error) {
            this.ui.log(`❌ Initialization failed: ${error.message}`, 'error')
            console.error('[SVphone] Init error:', error)
        }
    }

    /**
     * Sync wallet data from shared state
     */
    syncWalletData() {
        const myAddressField = document.getElementById('myAddress')
        let found = false

        // Try 1: Get address from bundle.js wallet (if wallet.html is open in same session)
        const addressEl = document.getElementById('address')
        if (addressEl && addressEl.textContent && addressEl.textContent !== '...') {
            const addr = addressEl.textContent.trim()
            myAddressField.value = addr
            // Don't auto-populate callee - let user enter the address they want to call
            this.ui.log(`✓ Wallet synced from bundle: ${addr}`, 'success')
            found = true
        }

        // Try 2: Get address from localStorage (if wallet.html was opened before)
        if (!found) {
            const storedAddress = localStorage.getItem('svphone_wallet_address')
            if (storedAddress && storedAddress !== '...') {
                myAddressField.value = storedAddress
                // Don't auto-populate callee - let user enter the address they want to call
                this.ui.log(`✓ Wallet restored from storage: ${storedAddress}`, 'success')
                found = true
            }
        }

        // If found, we're done
        if (found) return

        // If not found, show helpful message
        myAddressField.placeholder = 'Open wallet.html to load wallet address'
        this.ui.log('💡 Wallet not initialized. Open wallet.html first, then return here.', 'info')
    }

    /**
     * Load last called address from storage
     */
    loadLastCalled() {
        const lastCalledAddress = localStorage.getItem('svphone_phone_last_called_address')
        const lastCalledBtn = document.getElementById('lastCalledBtn')
        const lastCalledBtnText = document.getElementById('lastCalledBtnText')
        const lastCalledInfo = document.getElementById('lastCalledInfo')
        const lastCalledAddressEl = document.getElementById('lastCalledAddress')

        if (lastCalledAddress && lastCalledAddress.trim()) {
            // Show the redial button with the address
            lastCalledBtnText.textContent = lastCalledAddress.slice(0, 10) + '...'
            lastCalledBtn.style.display = 'block'

            // Show the info text
            lastCalledAddressEl.textContent = lastCalledAddress
            lastCalledInfo.style.display = 'block'
        } else {
            lastCalledBtn.style.display = 'none'
            lastCalledInfo.style.display = 'none'
        }
    }

    /**
     * Save last called address
     */
    saveLastCalled(address) {
        if (address && address.trim()) {
            localStorage.setItem('svphone_phone_last_called_address', address.trim())
            this.loadLastCalled()
        }
    }

    // ─── Public proxy methods for inline onclick handlers in HTML ────────

    toggleMicTest()        { this.micHandlers.toggleMicTest() }
    startMicTest()         { return this.micHandlers.startMicTest() }
    stopMicTest()          { this.micHandlers.stopMicTest() }
    startRecording()       { return this.micHandlers.startRecording() }
    stopRecording()        { this.micHandlers.stopRecording() }
    playRecording()        { this.micHandlers.playRecording() }

    toggleCameraTest()     { this.cameraHandlers.toggleCameraTest() }
    startCameraTest()      { return this.cameraHandlers.startCameraTest() }
    stopCameraTest()       { this.cameraHandlers.stopCameraTest() }
    toggleCameraSize()     { this.cameraHandlers.toggleCameraSize() }
    enterCameraFullscreen(){ return this.cameraHandlers.enterCameraFullscreen() }

    initializeCall()       { return this.callHandlers.initializeCall() }
    toggleMediaStream()    { return this.callHandlers.toggleMediaStream() }
    acceptCall()           { return this.callHandlers.acceptCall() }
    rejectCall()           { this.callHandlers.rejectCall() }
    endCall()              { return this.callHandlers.endCall() }
    clearConsole()         { this.ui.clearConsole() }

    /**
     * Add a contact from their identity string.
     * Called from the 1-TX Contacts UI section.
     */
    addContact() {
        const input = document.getElementById('newContactStr')
        if (!input || !this.contactsStore) return
        const parsed = this.contactsStore.parse(input.value.trim())
        if (!parsed) {
            this.ui.log('⚠️ Invalid identity string. Format: ADDRESS:sha-256:XX:XX:...[@IP]', 'error')
            return
        }
        this.contactsStore.save(parsed.address, parsed.fingerprint, parsed.ip || null)
        this.ui.log(`✓ Contact saved: ${parsed.address.slice(0, 16)}...${parsed.ip ? ' (IP: ' + parsed.ip + ')' : ''}`, 'success')
        input.value = ''
        this.refreshContactsList()
    }

    /**
     * Refresh the contacts list display in the UI.
     */
    refreshContactsList() {
        const el = document.getElementById('contactsList')
        if (!el || !this.contactsStore) return
        const contacts = this.contactsStore.getAll()
        if (contacts.length === 0) {
            el.innerHTML = '<span style="color:#6e7681;">No contacts yet — paste an identity string above.</span>'
            return
        }
        el.innerHTML = contacts.map(c => `
            <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
              <span style="flex:1;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                    title="${c.address}">${c.address.slice(0, 20)}...
              </span>
              <span style="color:#3fb950;font-size:0.75em;">1-TX</span>
              ${c.ip ? '<span style="color:#8b949e;font-size:0.65em;" title="ADF pre-punch IP: ' + c.ip + '">IP</span>' : ''}
              <button onclick="app.callContact('${c.address}')" style="padding:2px 8px;background:#1f6feb;border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:0.75em;">Call</button>
              <button onclick="app.removeContact('${c.address}')" style="padding:2px 8px;background:#da3633;border:none;border-radius:3px;color:#fff;cursor:pointer;font-size:0.75em;">✕</button>
            </div>`).join('')
    }

    /** Dial a contact directly from the contacts list */
    callContact(address) {
        const calleeField = document.getElementById('calleeAddress')
        if (calleeField) calleeField.value = address
    }

    /** Remove a contact */
    removeContact(address) {
        if (!this.contactsStore) return
        this.contactsStore.remove(address)
        this.ui.log(`Contact removed: ${address.slice(0, 16)}...`, 'info')
        this.refreshContactsList()
    }

    /**
     * Quick dial using last called address
     */
    quickDial() {
        const lastCalledAddress = localStorage.getItem('svphone_phone_last_called_address')
        if (lastCalledAddress) {
            document.getElementById('calleeAddress').value = lastCalledAddress
            this.ui.log(`📞 Quick dial: ${lastCalledAddress}`, 'info')
            this.callHandlers.initializeCall()
        }
    }

    /**
     * Auto-detect network configuration
     */
    async autoDetectNetworkConfig() {
        const myIpField = document.getElementById('myIp')
        const myPortField = document.getElementById('myPort')

        // Assign random UDP port in standard VoIP range (3478-3497)
        // These ports are typically open on firewalls for apps like FaceTime and Game Center
        const minPort = 3478
        const maxPort = 3497
        const randomPort = minPort + Math.floor(Math.random() * (maxPort - minPort + 1))
        myPortField.value = randomPort
        this.assignedUdpPort = randomPort
        console.log(`[SVphone] Assigned UDP port: ${randomPort} (VoIP range 3478-3497)`)

        // Public IP is discovered via STUN during call setup
        myIpField.value = ''
        myIpField.placeholder = 'Detected via STUN'
        this._detectedIp4 = null
        this._detectedIp6 = null
    }

    /**
     * Bind HTML event listeners to handlers
     */
    bindEvents() {
        // ========== Call Manager Events ==========
        this.callManager.on('call:log', ({ msg, type }) => this.ui.log(msg, type))

        this.callManager.on('call:initiated-session', (session) => {
            this.ui.log(`📞 Call initiated to ${session.calleeAddress}`, 'info')
            this.currentCallToken = session.callTokenId
            this.currentRole = 'caller'
            this.ui.updateCallStatus('ringing', 'Call ringing...')
            this.playRingtone()  // Play ring sound when calling
        })

        this.callManager.on('call:incoming-session', (session) => {
            if (session.identityExchange) {
                this.ui.log(`Incoming identity exchange request from ${session.caller}`, 'info')
                this.showIncomingCall(session.caller, session.callTokenId, true)
            } else {
                this.ui.log(`Incoming call from ${session.caller}`, 'info')
                this.showIncomingCall(session.caller, session.callTokenId, false)
            }
            this.currentCallToken = session.callTokenId
            this.currentRole = 'callee'
        })

        this.callManager.on('call:answered-session', (session) => {
            const remoteAddress = session.callee || session.calleeAddress
            const remoteParty   = remoteAddress || session.answerer
            console.debug(`[RECV] ✅ CALL ANSWERED by ${remoteParty}`)

            // Cancel outgoing ring and unanswered timeout
            this.ui.stopOutgoingRing()
            if (this._unansweredTimeout) { clearTimeout(this._unansweredTimeout); this._unansweredTimeout = null }
            this.ui.log(`📞 Call answered by ${remoteParty}`, 'success')
            this.ui.updateCallStatus('answered', 'Call answered - ICE connecting...')

            if (session.sdpAnswer && remoteAddress) {
                // 2-TX fallback: received ANS token — set remote description to complete handshake.
                // (In 1-TX mode the synthetic answer was already set in initiateCall, so this
                //  event doesn't fire and this branch is not reached.)
                console.debug(`[RECV] 2-TX: Setting remote description (answer SDP) for ${remoteAddress}`)
                this.peerConnection.setRemoteDescription(remoteAddress, { type: 'answer', sdp: session.sdpAnswer })
                    .then(() => {
                        this.ui.log('✓ WebRTC handshake complete, ICE connecting...', 'success')
                        this.ui.log(`[ICE] Callee ip4: ${session.calleeIp4 ?? 'none'} ip6: ${session.calleeIp6 ?? 'none'}`, 'info')
                        if (session.calleeIp4 || session.calleeIp6) {
                            const pubCandidates = this.peerConnection._buildPublicIpCandidates(
                                session.sdpAnswer, session.calleeIp4 ?? null, session.calleeIp6 ?? null,
                                this.ui.log.bind(this.ui)
                            )
                            for (const c of pubCandidates) {
                                this.peerConnection.addIceCandidate(remoteAddress, c)
                                    .catch(e => console.warn('[Phone] Public IP candidate rejected:', e.message))
                            }
                        }
                    })
                    .catch(err => this.ui.log(`⚠️ WebRTC answer error: ${err.message}`, 'error'))
            } else {
                // Callee local event (from signaling.acceptCall): ICE is already running
                // via createAnswerMunged() in call_manager.acceptCall().
                console.debug('[RECV] Callee ICE running (1-TX or local acceptCall)')
                this.calleeConnectionData = {
                    address:    remoteAddress,
                    ip:         session.calleeIp,
                    port:       session.calleePort,
                    sessionKey: session.calleeSessionKey
                }
            }
        })

        this.callManager.on('call:identity-exchanged', (data) => {
            this.ui.stopOutgoingRing()
            this.ui.stopRingtone()
            if (this._unansweredTimeout) { clearTimeout(this._unansweredTimeout); this._unansweredTimeout = null }
            if (this._incomingTimeout) { clearTimeout(this._incomingTimeout); this._incomingTimeout = null }
            document.getElementById('incomingCall').style.display = 'none'
            document.getElementById('acceptBtn').style.display = 'none'
            document.getElementById('rejectBtn').style.display = 'none'
            if (data.role === 'caller') {
                this.ui.log(`✓ Contact saved for ${data.address}! You can now call them.`, 'success')
            } else {
                this.ui.log(`✓ Identity exchanged with ${data.address}. Contact saved.`, 'success')
            }
            this.ui.updateCallStatus('ended', 'Identity exchanged')
            this.ui.updateCallButtonStatus('idle')
            this.refreshContactsList()
        })

        // Port discovery: callee's STUN found its srflx — broadcast PORT token to caller
        this.callManager.on('call:port-discovered', async (data) => {
            if (!this.callTokenManager) return
            try {
                const myAddress = this.signaling.myAddress
                if (!myAddress) return
                const portFeePerKb = parseFloat(document.getElementById('feeRate')?.value) || 100
                this.ui.log(`[ANS] Broadcasting answer + port ${data.port} to caller... (fee ${portFeePerKb} sats/KB)`, 'info')
                const portResult = await this.callTokenManager.broadcastCallAnswer(data.callerAddress, {
                    callee:            myAddress,
                    senderIp:          data.ip,
                    senderIp4:         data.ip,
                    senderPort:        data.port,
                    sessionKey:        data.sessionKey || '',
                    codec:             'opus',
                    quality:           'hd',
                    mediaTypes:        ['audio'],
                    sdpAnswer:         data.sdpAnswer || '',
                    calleeFingerprint: data.calleeFingerprint || '',
                    feePerKb:          portFeePerKb,
                })
                this.ui.log(`[ANS] Answer + port ${data.port} announced — waiting for mempool confirmation before spray`, 'info')
                // Wait until ANS TX is visible on WoC before spraying.
                // The caller also waits for this TX via polling, so both sides
                // start spraying at approximately the same time. This prevents
                // the callee's early spray from triggering flood protection on
                // the caller's router (unsolicited incoming packets before the
                // caller has sent anything outbound).
                const ansTxId = portResult?.txId
                if (ansTxId) {
                    this.ui.log(`[ANS] ANS TX broadcast (${ansTxId.slice(0,12)}…) — waiting for UTXO detection to start spray`, 'info')
                }
                // Spray is NOT started here. Both caller and callee start spray
                // when they detect the ANS token via UTXO polling (onCallAnswered).
                // This synchronizes both sides to within one polling interval.
            } catch (err) {
                this.ui.log(`[ANS] Failed to broadcast answer: ${err.message}`, 'error')
            }
        })

        this.callManager.on('call:connected', () => {
            console.debug('[call:connected] Event listener fired!')
            this.ui.stopOutgoingRing()
            this.ui.stopRingtone()
            if (this._unansweredTimeout) { clearTimeout(this._unansweredTimeout); this._unansweredTimeout = null }
            this.ui.log('📞 Call connected! Media stream established', 'success')
            this.ui.updateCallStatus('connected', 'Call connected')
            document.getElementById('endCallBtn').style.display = 'inline-block'
            console.debug('[call:connected] About to call showCallStats()')
            this.ui.showCallStats()
            console.debug('[call:connected] showCallStats() completed')
            this.callStartTime = Date.now()
            this.ui.startDurationTimer()
            // Acquire screen wake lock to prevent screen sleep from dropping the call
            if ('wakeLock' in navigator) {
                navigator.wakeLock.request('screen')
                    .then(lock => { this.wakeLock = lock; this.ui.log('Screen wake lock active', 'info') })
                    .catch(e => console.warn('[WakeLock] Could not acquire:', e.message))
            }
        })

        this.callManager.on('call:ended-session', (data) => {
            this.ui.log(`📞 Call ended. Duration: ${(data.duration/1000).toFixed(1)}s`, 'info')
            this.ui.resetCallUI()
            this.ui.stopDurationTimer()
            // Clear call state so next call works cleanly
            this.currentCallToken = null
            this.currentRole = null
            if (this._unansweredTimeout) { clearTimeout(this._unansweredTimeout); this._unansweredTimeout = null }
            if (this._incomingTimeout) { clearTimeout(this._incomingTimeout); this._incomingTimeout = null }
            // Release screen wake lock
            if (this.wakeLock) { this.wakeLock.release(); this.wakeLock = null }
        })

        // Re-acquire wake lock if browser releases it (e.g. tab hidden then shown) during an active call
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.wakeLock === null && this.currentCallToken) {
                navigator.wakeLock?.request('screen')
                    .then(lock => { this.wakeLock = lock })
                    .catch(() => {})
            }
        })

        // ========== Quality Adaptation Events ==========
        this.quality.on('quality:changed', (data) => {
            this.ui.log(`📊 Quality changed: ${data.oldQuality} → ${data.newQuality}`, 'warning')
            this.ui.updateQuality(data.newQuality)
        })

        // ========== Call Manager Stats Events ==========
        this.callManager.on('call:stats-updated', (data) => {
            this.ui.updateStats(data.stats)
        })

        // ========== Peer Connection Events ==========
        this.peerConnection.on('media:ready', () => {
            this.ui.log('🎤 Media stream ready', 'success')
            this.attachLocalVideo()
        })

        this.peerConnection.on('media:track-received', (data) => {
            this.ui.log(`📹 Received remote ${data.track.kind} track`, 'info')
            this.attachRemoteVideo(data.stream)
        })

        // ========== Security Events ==========
        this.security.on('security:dtls-connected', () => {
            this.ui.log('🔒 DTLS encryption established', 'success')
            this.ui.updateEncryption('DTLS v1.2')
        })




        // ========== Microphone Test UI ==========
        document.getElementById('micTestToggle')?.addEventListener('click', () => this.micHandlers.toggleMicTest())
        document.getElementById('startMicTestBtn')?.addEventListener('click', () => this.micHandlers.startMicTest())
        document.getElementById('stopMicTestBtn')?.addEventListener('click', () => this.micHandlers.stopMicTest())
        document.getElementById('micVolumeSlider')?.addEventListener('input', (e) => this.micHandlers.updateMicVolume(e.target.value))
        document.getElementById('micMuteCheckbox')?.addEventListener('change', (e) => this.micHandlers.toggleMicMute(e.target.checked))
        document.getElementById('startRecordBtn')?.addEventListener('click', () => this.micHandlers.startRecording())
        document.getElementById('stopRecordBtn')?.addEventListener('click', () => this.micHandlers.stopRecording())
        document.getElementById('playRecordBtn')?.addEventListener('click', () => this.micHandlers.playRecording())

        // ========== Camera Test UI ==========
        document.getElementById('cameraTestToggle')?.addEventListener('click', () => this.cameraHandlers.toggleCameraTest())
        document.getElementById('startCameraTestBtn')?.addEventListener('click', () => this.cameraHandlers.startCameraTest())
        document.getElementById('stopCameraTestBtn')?.addEventListener('click', () => this.cameraHandlers.stopCameraTest())
        document.getElementById('cameraResolution')?.addEventListener('change', (e) => this.cameraHandlers.changeCameraResolution(e.target.value))
        document.getElementById('toggleCameraSizeBtn')?.addEventListener('click', () => this.cameraHandlers.toggleCameraSize())
        document.getElementById('cameraFullscreenBtn')?.addEventListener('click', () => this.cameraHandlers.enterCameraFullscreen())
    }

    /**
     * Start background polling for incoming calls
     */
    async startBackgroundPolling() {
        // Start listening for incoming call signals in background.
        // This runs continuously so recipient can receive calls anytime.
        const myAddress = document.getElementById('myAddress')?.value

        if (!window.tokenBuilder || !window.provider || !myAddress || !this.callTokenManager) {
            this.ui.log(`⏳ Waiting for wallet to load (will retry in 2s)...`, 'warning')
            setTimeout(() => this.startBackgroundPolling(), 2000)
            return
        }

        // Ensure signaling is initialized with wallet address BEFORE polling
        if (!this.signaling.myAddress) {
            this.signaling.myAddress = myAddress
        }

        try {
            const seenTxIds = new Set()

            // Pre-seed seenTxIds with current UTXOs so existing TXs are ignored.
            // Only new UTXOs (new calls/answers) will be processed.
            try {
                const initialUtxos = await window.provider.getUtxos()
                for (const u of initialUtxos) seenTxIds.add(u.txId)
                console.log(`[Poll] Pre-seeded ${seenTxIds.size} existing txIds from UTXOs — will only process new signals`)
            } catch (e) {
                console.warn('[Poll] Could not pre-seed seenTxIds:', e.message)
            }

            // Scan UTXOs for SVphone call/answer OP_RETURN signals.
            // UTXOs reflect mempool changes almost instantly (vs address history
            // which can lag 30-60s on WoC).
            const scanSignalsFn = async (address) => {
                if (!address) return []

                const utxos = await window.provider.getUtxos()
                const results = []

                // Collect unique new txIds from UTXOs
                const newTxIds = []
                for (const u of utxos) {
                    if (seenTxIds.has(u.txId)) continue
                    newTxIds.push(u.txId)
                    seenTxIds.add(u.txId)
                }
                if (newTxIds.length > 0) {
                    console.log(`[Poll] address=${address.slice(0,12)}… ${newTxIds.length} new UTXO txId(s)`)
                }

                // Cap seenTxIds to prevent unbounded growth
                if (seenTxIds.size > 500) {
                    const iter = seenTxIds.values()
                    while (seenTxIds.size > 400) seenTxIds.delete(iter.next().value)
                }

                for (const txId of newTxIds) {

                    try {
                        const tx = await window.provider.getSourceTransaction(txId)

                        // Scan outputs for P OP_RETURN call signals
                        let signal = null
                        let lastDecoded = null
                        for (const output of tx.outputs) {
                            if (!output.lockingScript) continue
                            const decoded = window.decodeOpReturn(output.lockingScript)
                            if (!decoded) continue
                            const name = decoded.tokenName
                            if (!name?.startsWith('CALL-') && !name?.startsWith('ANS-') && !name?.startsWith('CXID-')) continue

                            const attrs = this.callTokenManager.decodeCallAttributes(decoded.tokenAttributes)
                            if (!attrs?.senderIp) continue

                            const isCall = (name.startsWith('CALL-') || name.startsWith('CXID-')) && attrs.callee === address
                            const isAnswer = name.startsWith('ANS-') && (attrs.caller === address || attrs.callee === address)
                            if (!isCall && !isAnswer) continue

                            // SDP is in stateData (P protocol conformant), not tokenAttributes
                            const sdpStr = this.callTokenManager.decodeStateData(decoded.stateData)

                            signal = {
                                type: isCall ? 'call' : 'answer',
                                caller: attrs.caller,
                                callee: attrs.callee,
                                ip: attrs.senderIp,
                                ip4: attrs.senderIp4 ?? null,
                                ip6: attrs.senderIp6 ?? null,
                                port: attrs.senderPort,
                                key: attrs.sessionKey,
                                codec: attrs.codec,
                                quality: attrs.quality,
                                media: attrs.mediaTypes,
                                callerFingerprint: attrs.callerFingerprint ?? null,
                                // CALL: wrap as object so call_manager.js can access .sdp property
                                // ANS:  plain string — signaling.js wraps it
                                sdp: isCall ? { type: 'offer', sdp: sdpStr }
                                            : sdpStr,
                            }
                            lastDecoded = decoded
                            break
                        }

                        if (signal) {
                            // UI-visible log so user can verify decoded token data
                            const sdpStr = signal.sdp ? (typeof signal.sdp === 'object' ? signal.sdp.sdp : signal.sdp) : ''
                            const sdpLen = sdpStr?.length ?? 0
                            const sdpCands = (sdpStr.match(/a=candidate:/g) || []).length
                            // Extract ICE creds from decoded SDP for cross-check
                            const sdpUfrag = sdpStr.match(/a=ice-ufrag:(\S+)/)?.[1] || '?'
                            const sdpPwd = sdpStr.match(/a=ice-pwd:(\S+)/)?.[1] || '?'
                            this.ui.log(
                                `[Token] ${signal.type.toUpperCase()}: ip4=${signal.ip4 ?? 'none'} ` +
                                `ip6=${signal.ip6 ? signal.ip6.slice(0,16)+'…' : 'none'} ` +
                                `port=${signal.port ?? 0} sdp=${sdpLen}B (${sdpCands} cands) ` +
                                `ufrag=${sdpUfrag} key=${(signal.key || '').slice(0,8)}…`,
                                'info'
                            )
                            // Log stateData hex length for integrity check
                            console.log(`[Token-DBG] stateData hex=${lastDecoded?.stateData?.length ?? 0} chars, SDP=${sdpLen} chars, starts: ${sdpStr.slice(0,30)}`)
                            results.push({ txId, inscription: signal })
                        }
                    } catch (e) {
                        console.warn(`[Poll] fetch failed for ${txId.slice(0,12)}…:`, e.message)
                    }
                }

                return results
            }

            // Start polling
            this.signaling.startPolling(scanSignalsFn)
            this.ui.log('📞 Background polling for incoming calls started', 'success')
            // call:incoming and call:answered are forwarded by CallManager via
            // call:incoming-session and call:answered-session — handled in bindEvents()
        } catch (error) {
            this.ui.log('[BgPolling] Failed to start: ' + error.message, 'error')
        }
    }

    /**
     * Show incoming call UI
     */
    showIncomingCall(caller, callTokenId, identityExchange = false) {
        console.debug(`[RECV] ✅ INCOMING ${identityExchange ? 'IDENTITY EXCHANGE' : 'CALL'} DETECTED! Caller: ${caller}`)
        this.currentCallToken = callTokenId
        this.ui.showIncomingCall(caller, identityExchange)

        // Auto-return to standby if not answered within 3 minutes
        this._incomingTimeout = setTimeout(() => {
            this._incomingTimeout = null
            this.ui.log('⏱ Incoming call timed out — returning to standby', 'info')
            this.ui.resetCallUI()
        }, 3 * 60 * 1000)
    }

    /**
     * Play ringtone sound
     */
    playRingtone() {
        try {
            // Create a simple ringtone using Web Audio API
            const audioContext = new (window.AudioContext || window.webkitAudioContext)()
            const oscillator = audioContext.createOscillator()
            const gainNode = audioContext.createGain()

            oscillator.connect(gainNode)
            gainNode.connect(audioContext.destination)

            // Ring pattern: 440Hz (A4) for 0.5s, 0.5s silence, repeat 2x
            oscillator.frequency.value = 440
            gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)

            const startTime = audioContext.currentTime
            oscillator.start(startTime)
            gainNode.gain.setValueAtTime(0.3, startTime)
            gainNode.gain.setValueAtTime(0, startTime + 0.5)

            gainNode.gain.setValueAtTime(0.3, startTime + 1)
            gainNode.gain.setValueAtTime(0, startTime + 1.5)

            oscillator.stop(startTime + 1.5)
        } catch (error) {
            console.warn('Ringtone playback failed:', error)
        }
    }

    /**
     * Attach local video stream
     */
    attachLocalVideo() {
        const stream = this.peerConnection.mediaStream
        if (stream) {
            this.ui.attachLocalVideo(stream)
        }
    }

    /**
     * Attach remote video stream
     */
    attachRemoteVideo(stream) {
        this.ui.attachRemoteVideo(stream)
    }
}

// Initialize application when DOM is ready
let phoneApp = null

function initPhoneApp() {
    try {
        console.log('[SVphone] Initializing phone application...')
        phoneApp = new PhoneController()
        window.app = phoneApp
        window.phoneApp = phoneApp
        console.log('[SVphone] Phone application initialized successfully')
    } catch (error) {
        console.error('[SVphone] Initialization error:', error)
        console.error('[SVphone] Stack:', error.stack)
        alert('SVphone initialization failed: ' + error.message)
    }
}

// Wait for DOM to be fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPhoneApp)
} else {
    initPhoneApp()
}

// Export for external access
window.PhoneController = PhoneController
