# WebRTC Core Library (v06.00)

**Original WebRTC Implementation** - Pure peer-to-peer media connection library

## Overview

This directory contains the original, unmodified WebRTC source code used by SVphone. It provides:

- **RTCPeerConnection lifecycle management** - Create, configure, and manage P2P media connections
- **Media stream handling** - Audio/video capture with fallback strategies
- **ICE/STUN/TURN support** - NAT traversal with configurable servers
- **Connection state monitoring** - Track ICE, signaling, and media connection states
- **Statistics collection** - Real-time bandwidth, latency, packet loss, FPS metrics
- **Event-driven architecture** - Emit events for all state changes and errors

## Files

### peer_connection.js
Pure WebRTC PeerConnection manager class.

**Key Methods:**
- `initializeMediaStream(options)` - Get audio/video from user devices
- `createPeerConnection(peerId)` - Create RTCPeerConnection with ICE config
- `createOffer(peerId)` - Create SDP offer for initiating calls
- `createAnswer(peerId, offerSdp)` - Create SDP answer for receiving calls
- `setRemoteDescription(peerId, description)` - Set remote SDP
- `addIceCandidate(peerId, candidate)` - Add ICE candidates
- `getStats(peerId)` - Get connection statistics
- `closePeerConnection(peerId)` - Close connection
- `on(eventName, callback)` - Event listener registration

**Events Emitted:**
- `media:ready` - Local media stream initialized
- `media:error` - Media initialization failed
- `ice:candidate` - New ICE candidate generated
- `media:track-received` - Remote audio/video track received
- `peer:connection-state-changed` - Connection state changed
- `peer:connected` - P2P connection established
- `peer:connection-failed` - Connection failed

## Usage Example

```javascript
// Import (browser or module)
// In HTML: <script src="peer_connection.js"></script>
// In Node: const PeerConnection = require('./peer_connection.js');

// Create instance with STUN/TURN configuration
const peerConnection = new PeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ],
  turnServer: {
    host: 'turn.example.com',
    port: 3478,
    username: 'user',
    credential: 'password'
  }
});

// Initialize local media
await peerConnection.initializeMediaStream({
  audio: true,
  video: true
});

// Listen for connection events
peerConnection.on('peer:connected', (data) => {
  console.log('Connected to peer:', data.peerId);
});

// Create offer to initiate call
const offer = await peerConnection.createOffer('peer-id-123');

// Send offer via signaling (blockchain in SVphone case)
// ... send offer through signaling channel ...

// Receive answer and set remote description
const answer = await receiveAnswerFromPeer();
await peerConnection.setRemoteDescription('peer-id-123', answer);

// Get connection quality
const stats = await peerConnection.getStats('peer-id-123');
console.log('RTT:', stats.connection.currentRoundTripTime);
console.log('Bandwidth:', stats.connection.availableOutgoingBitrate);
```

## Configuration

### ICE Servers
Default configuration uses Google's public STUN servers (no auth required):
- stun.l.google.com:19302
- stun1.l.google.com:19302
- stun2.l.google.com:19302
- stun3.l.google.com:19302
- stun4.l.google.com:19302

### Media Constraints
Default audio/video constraints:
- **Audio**: Echo cancellation, noise suppression, auto-gain control
- **Video**: 1280×720 @ 30fps ideal (adaptive to device capabilities)

## Architecture

```
PeerConnection
├── Media Capture (getUserMedia)
├── RTCPeerConnection management
│   ├── ICE candidate gathering
│   ├── SDP offer/answer negotiation
│   └── Track management
├── Connection state monitoring
└── Statistics collection
```

## Separation of Concerns

**This directory (WebRTC)**: Pure WebRTC implementation
- No blockchain knowledge
- No SVphone-specific logic
- Generic peer connection management
- Reusable for any WebRTC application

**Parent directory (sv_connect)**: SVphone customizations
- `signaling.js` - Blockchain-based call token signaling
- `call_manager.js` - SVphone orchestration layer
- Integration with token protocol

## Future Updates

When WebRTC standards evolve or issues are discovered:

1. Update `peer_connection.js` in this directory
2. Changes automatically available to `sv_connect` via imports
3. Reduces chance of accidentally modifying both original and custom code
4. Easier to merge upstream improvements

## Standards & References

- [WebRTC W3C Specification](https://w3c.github.io/webrtc-pc/)
- [RTCPeerConnection API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection)
- [WebRTC NAT Traversal (RFC 8445)](https://datatracker.ietf.org/doc/html/rfc8445)
- [DTLS-SRTP Security (RFC 8827)](https://datatracker.ietf.org/doc/html/rfc8827)
