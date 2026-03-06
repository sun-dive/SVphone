# Debugging Media Display Issue in v06_12

## Problem
Media display (#videoContainer) not appearing when call connection is made.

## Possible Causes

```
ISSUE: Media display not appearing
├─ Cause 1: Call connection NOT actually established
│  └─ Check: Is 'peer:connected' event firing?
│
├─ Cause 2: Event fired but listener not attached
│  └─ Check: Is callManager.on('call:connected') registered?
│
├─ Cause 3: showCallStats() not being called
│  └─ Check: Is onPeerConnected() being reached?
│
├─ Cause 4: showCallStats() called but CSS not updating
│  └─ Check: #videoContainer visibility
│
└─ Cause 5: WebRTC connection broken
   └─ Check: Are media tracks being exchanged?
```

## Debug Steps

### Step 1: Check Browser Console for Errors

Open DevTools (F12) → Console tab and look for:
- ❌ `[PeerConnection]` errors
- ❌ `[CallManager]` errors
- ❌ `peer:connected` NOT logged
- ❌ WebRTC connection errors

### Step 2: Check for These Console Logs

After making a call, you should see:
```
[PeerConnection] Media stream initialized: {audioTracks: 1, videoTracks: 1}
[CallManager] Initiated call to: 1A...
[RECV] ✅ INCOMING CALL DETECTED!
[CallManager] Accepted call
[PeerConnection] Peer connection created
[CallManager] Peer connected
📞 Call connected! Media stream established
```

If any of these are missing, that's where it's failing.

### Step 3: Add Debugging Logs

Add these console.log statements to identify the problem:

#### In `call_manager.js` - `onPeerConnected()` method (around line 262):

```javascript
onPeerConnected(data) {
    console.log('[DEBUG] onPeerConnected called with:', data)  // ← ADD THIS

    // Find session by peer ID
    let session = null
    for (const [callTokenId, sess] of this.activeCallSessions) {
        const callToken = this.signaling.getCallToken(callTokenId)
        if (callToken) {
            const peerId = sess.role === 'caller' ? callToken.callee : callToken.caller
            if (peerId === data.peerId) {
                session = sess
                break
            }
        }
    }

    if (session) {
        console.log('[DEBUG] Found session:', session.callTokenId)  // ← ADD THIS
        session.status = 'connected'
        session.connectedAt = Date.now()

        this.startStatsMonitoring(session.callTokenId)

        console.log('[DEBUG] About to emit call:connected')  // ← ADD THIS
        this.emit('call:connected', {
            callTokenId: session.callTokenId,
            timestamp: Date.now()
        })
        console.log('[DEBUG] Emitted call:connected')  // ← ADD THIS
    } else {
        console.log('[DEBUG] NO SESSION FOUND - This is the problem!')  // ← ADD THIS
    }
}
```

#### In `phone_interface.html` - Event listener (around line 1374):

```javascript
this.callManager.on('call:connected', () => {
    console.log('[DEBUG] call:connected listener fired!')  // ← ADD THIS
    this.log('📞 Call connected! Media stream established', 'success')
    this.updateCallStatus('connected', 'Call connected')
    console.log('[DEBUG] About to call showCallStats')  // ← ADD THIS
    this.showCallStats()
    console.log('[DEBUG] showCallStats called')  // ← ADD THIS
    this.callStartTime = Date.now()
    this.startDurationTimer()
})
```

#### In `phone_interface.html` - `showCallStats()` method (around line 2191):

```javascript
showCallStats() {
    console.log('[DEBUG] showCallStats called')  // ← ADD THIS
    const videoContainer = document.getElementById('videoContainer')
    console.log('[DEBUG] videoContainer element:', videoContainer)  // ← ADD THIS
    if (videoContainer) {
        console.log('[DEBUG] Setting videoContainer display to grid')  // ← ADD THIS
        videoContainer.style.display = 'grid'
        console.log('[DEBUG] videoContainer display set. Current:', videoContainer.style.display)  // ← ADD THIS
    } else {
        console.log('[DEBUG] ERROR: videoContainer element NOT FOUND!')  // ← ADD THIS
    }

    const statsGrid = document.getElementById('statsGrid')
    console.log('[DEBUG] statsGrid element:', statsGrid)  // ← ADD THIS
    if (statsGrid) {
        statsGrid.style.display = 'grid'
    }
}
```

### Step 4: Run Test and Check Console Output

1. Open two browser windows
2. Open DevTools in both (F12)
3. Make a call from browser A to browser B
4. Watch the console logs appear in real-time
5. Share which logs appear and which are missing

### Step 5: Check Network Tab (Advanced)

Open DevTools → Network tab and look for:
- ✅ WebRTC connections (SDP, ICE candidates)
- ❌ Errors in WebRTC negotiation
- Check if answer token was broadcast

### Step 6: Check Elements Tab

Open DevTools → Elements tab:
1. Search for `id="videoContainer"`
2. Verify element exists in DOM
3. Check its current `display` style
4. If `display: none`, that's why it's hidden

```html
<div class="video-container" id="videoContainer" style="display:none;">
    <!-- Should change to display:grid when connected -->
</div>
```

## Most Likely Issues (in order of probability)

### Issue #1: onPeerConnected() Not Finding Session
**Symptoms:**
- `[DEBUG] NO SESSION FOUND - This is the problem!` in console
- Call status shows "connected" but no video

**Cause:**
- Session lookup by peerId failed
- CallToken doesn't match

**Fix:**
- Check if `signaling.getCallToken(callTokenId)` is returning the token
- Verify peerId matches

### Issue #2: Event Listener Not Registered
**Symptoms:**
- `[DEBUG] call:connected listener fired!` NOT in console
- But CallManager did emit the event

**Cause:**
- Event listener not attached before event fires
- Race condition in initialization

**Fix:**
- Move event listener registration earlier
- Use `.once()` instead of `.on()` for testing

### Issue #3: showCallStats() Not Called
**Symptoms:**
- `[DEBUG] showCallStats called` NOT in console
- Event listener fired but method not called

**Cause:**
- JavaScript error before showCallStats()
- `this` binding issue

**Fix:**
- Check console for JavaScript errors
- Use arrow function for event listener

### Issue #4: videoContainer Element Not Found
**Symptoms:**
- `[DEBUG] videoContainer element: null` in console
- showCallStats() called but nothing happens

**Cause:**
- HTML element missing or wrong ID
- HTML not loaded yet when JavaScript runs

**Fix:**
- Verify `<div id="videoContainer">` exists in HTML
- Check if phone_interface.html is being served correctly

### Issue #5: WebRTC Connection Not Established
**Symptoms:**
- No `[DEBUG] onPeerConnected called` in console
- Call shows "connecting" forever

**Cause:**
- P2P connection failed
- ICE candidates not exchanged properly
- STUN/TURN server issues

**Fix:**
- Check peer_connection.js for connection errors
- Look for `[PeerConnection] Peer connection failed` logs
- Verify NAT/firewall not blocking WebRTC

## Testing Checklist

- [ ] Open two browser windows with v06_12
- [ ] Browser A initiates call to Browser B
- [ ] Browser B accepts call
- [ ] Watch console logs in real-time
- [ ] Identify where logs stop appearing
- [ ] Report which logs are missing
- [ ] Share any error messages

## Expected Console Flow (Normal Case)

```
A initiates:
[PeerConnection] Media stream initialized: {audioTracks: 1, videoTracks: 1}
[CallManager] Initiated call to: 1ABC...
[CallManager] Initiating call...

B detects:
[RECV] ✅ INCOMING CALL DETECTED!
[RECV] Incoming call from: 1ABC...
showIncomingCall called with caller: 1ABC...

B accepts:
[PeerConnection] Media stream initialized: {audioTracks: 1, videoTracks: 1}
[CallManager] Accepted call: token123...

Both:
[PeerConnection] Peer connection created
[CallManager] ✓ SDP offer created and stored in callToken
[CallManager] Accepting call token on blockchain

Connection:
[CallManager] Peer connected
[DEBUG] onPeerConnected called with: {peerId: "1ABC..."}
[DEBUG] Found session: callToken123
[DEBUG] About to emit call:connected
[DEBUG] Emitted call:connected
[DEBUG] call:connected listener fired!
📞 Call connected! Media stream established
[DEBUG] About to call showCallStats
[DEBUG] showCallStats called
[DEBUG] videoContainer element: <div ...>
[DEBUG] Setting videoContainer display to grid
[DEBUG] videoContainer display set. Current: grid
```

## If Still Stuck

Share with me:
1. **Browser console output** (copy-paste the relevant logs)
2. **Which debug log appeared last** (before it stopped)
3. **What the UI status shows** (e.g., "connecting", "connected", etc.)
4. **Any error messages** in the console
5. **Whether both local and remote video work** in camera test

This will help identify exactly where the flow breaks!
