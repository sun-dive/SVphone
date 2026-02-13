/**
 * WebRTC P2P Client Implementation (Latest Standard)
 *
 * Complete working example for browser-to-browser voice/video calling.
 * Source: Comprehensive Research on WebRTC (February 2026)
 *
 * Features:
 * - Direct P2P media connection with signaling server only
 * - Low-latency (<500ms), privacy-preserving
 * - STUN/TURN for NAT traversal
 * - Data channel for low-latency messaging
 * - Automatic DTLS-SRTP encryption
 */

// === Configuration ===
const CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    { urls: ['stun:stun2.l.google.com:19302'] },
    { urls: ['stun:stun3.l.google.com:19302'] },
    { urls: ['stun:stun4.l.google.com:19302'] }
  ]
  // Optional TURN for restrictive NAT:
  // {
  //   urls: ['turn:turn.example.com:3478'],
  //   username: 'user',
  //   credential: 'password'
  // }
};

const signalingServer = 'wss://signaling.example.com';

// === State Management ===
let peerConnection;
let dataChannel;
let localStream;
let remoteStream;
let signalingSocket;
let isInitiator = false;

// === Connection Setup ===
async function initializePeerConnection() {
  try {
    peerConnection = new RTCPeerConnection(CONFIG);

    // Get local media
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      }
    });

    // Display local video
    const localVideoElement = document.getElementById('local-video');
    if (localVideoElement) {
      localVideoElement.srcObject = localStream;
    }

    // Add tracks to peer connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    // Setup data channel for messaging
    dataChannel = peerConnection.createDataChannel('messages');
    setupDataChannel(dataChannel);

    // Handle remote stream
    peerConnection.ontrack = (event) => {
      console.log('Received remote track:', event.track.kind);
      remoteStream = event.streams[0];
      const remoteVideoElement = document.getElementById('remote-video');
      if (remoteVideoElement) {
        remoteVideoElement.srcObject = remoteStream;
      }
      emitEvent('media:ready');
    };

    // Handle incoming data channel
    peerConnection.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        signalingSocket.send(JSON.stringify({
          type: 'ice-candidate',
          candidate: event.candidate
        }));
      }
    };

    // Monitor connection state
    peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', peerConnection.connectionState);
      emitEvent('connection-state', { state: peerConnection.connectionState });

      if (peerConnection.connectionState === 'failed') {
        console.warn('Connection failed, attempting ICE restart');
        restartConnection();
      }
    };

    // Monitor ICE connection state
    peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', peerConnection.iceConnectionState);
      emitEvent('ice-connection-state', { state: peerConnection.iceConnectionState });
    };

    console.log('PeerConnection initialized');
  } catch (error) {
    console.error('Failed to initialize peer connection:', error);
    emitEvent('error', { error, type: 'initialization' });
    throw error;
  }
}

// === Signaling Setup ===
function setupSignaling(url = signalingServer) {
  signalingSocket = new WebSocket(url);

  signalingSocket.onopen = () => {
    console.log('Signaling connected');
    emitEvent('signaling-connected');
  };

  signalingSocket.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      await handleSignalingMessage(message);
    } catch (error) {
      console.error('Error handling signaling message:', error);
      emitEvent('error', { error, type: 'signaling' });
    }
  };

  signalingSocket.onerror = (error) => {
    console.error('Signaling error:', error);
    emitEvent('error', { error, type: 'signaling-error' });
  };

  signalingSocket.onclose = () => {
    console.log('Signaling disconnected');
    emitEvent('signaling-disconnected');
  };
}

// === Signaling Message Handler ===
async function handleSignalingMessage(message) {
  try {
    if (message.type === 'offer') {
      console.log('Received offer');
      isInitiator = false;

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp: message.sdp })
      );

      // Create and send answer
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      signalingSocket.send(JSON.stringify({
        type: 'answer',
        sdp: answer.sdp
      }));

    } else if (message.type === 'answer') {
      console.log('Received answer');

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: message.sdp })
      );

    } else if (message.type === 'ice-candidate' && message.candidate) {
      console.log('Received ICE candidate');

      try {
        await peerConnection.addIceCandidate(
          new RTCIceCandidate(message.candidate)
        );
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    }
  } catch (error) {
    console.error('Error handling signaling message:', error);
    throw error;
  }
}

// === Call Initiation ===
async function startCall(remotePeerId = null) {
  try {
    console.log('Starting call...');

    // Initialize peer connection if not already done
    if (!peerConnection) {
      await initializePeerConnection();
    }

    // Setup signaling if not already done
    if (!signalingSocket) {
      setupSignaling();

      // Wait for signaling connection
      await new Promise((resolve) => {
        const checkConnection = setInterval(() => {
          if (signalingSocket && signalingSocket.readyState === WebSocket.OPEN) {
            clearInterval(checkConnection);
            resolve();
          }
        }, 100);
      });
    }

    // Create offer
    isInitiator = true;
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });

    await peerConnection.setLocalDescription(offer);

    // Send offer to remote peer
    signalingSocket.send(JSON.stringify({
      type: 'offer',
      sdp: offer.sdp,
      to: remotePeerId
    }));

    console.log('Call initiated, offer sent');
    emitEvent('call-initiated');

  } catch (error) {
    console.error('Failed to start call:', error);
    emitEvent('error', { error, type: 'call-initiation' });
    throw error;
  }
}

// === Data Channel Setup ===
function setupDataChannel(channel) {
  channel.onopen = () => {
    console.log('Data channel opened');
    emitEvent('data-channel-open');
    const sendButton = document.getElementById('send-button');
    if (sendButton) {
      sendButton.disabled = false;
    }
  };

  channel.onclose = () => {
    console.log('Data channel closed');
    emitEvent('data-channel-close');
    const sendButton = document.getElementById('send-button');
    if (sendButton) {
      sendButton.disabled = true;
    }
  };

  channel.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('Received message:', message);
      emitEvent('message-received', message);
      displayMessage('Remote', message.text);
    } catch (error) {
      console.error('Error handling data channel message:', error);
    }
  };

  channel.onerror = (error) => {
    console.error('Data channel error:', error);
    emitEvent('error', { error, type: 'data-channel' });
  };
}

// === Message Sending ===
function sendMessage(text) {
  if (text && dataChannel && dataChannel.readyState === 'open') {
    const message = {
      text,
      timestamp: Date.now(),
      type: 'text'
    };

    dataChannel.send(JSON.stringify(message));
    displayMessage('You', text);

    // Clear input
    const input = document.getElementById('message-input');
    if (input) {
      input.value = '';
    }
  } else {
    console.warn('Cannot send message: data channel not ready');
  }
}

// === Message Display ===
function displayMessage(sender, text) {
  const messagesDiv = document.getElementById('messages');
  if (messagesDiv) {
    const msgElement = document.createElement('p');
    msgElement.className = sender === 'You' ? 'sent-message' : 'received-message';
    msgElement.innerHTML = `<strong>${sender}:</strong> ${text}`;
    messagesDiv.appendChild(msgElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }
}

// === Connection Restart ===
async function restartConnection() {
  try {
    console.log('Restarting ICE...');
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);

    signalingSocket.send(JSON.stringify({
      type: 'offer',
      sdp: offer.sdp
    }));

    console.log('ICE restart initiated');
    emitEvent('ice-restart');
  } catch (error) {
    console.error('Error restarting ICE:', error);
    emitEvent('error', { error, type: 'ice-restart' });
  }
}

// === Connection Statistics ===
async function getConnectionStats() {
  if (!peerConnection) {
    return null;
  }

  try {
    const stats = await peerConnection.getStats();
    const report = {
      audio: { inbound: {}, outbound: {} },
      video: { inbound: {}, outbound: {} },
      connection: {},
      candidates: []
    };

    stats.forEach(stat => {
      // Audio inbound
      if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
        report.audio.inbound = {
          bytesReceived: stat.bytesReceived,
          packetsReceived: stat.packetsReceived,
          packetsLost: stat.packetsLost,
          jitter: stat.jitter,
          audioLevel: stat.audioLevel
        };
      }

      // Audio outbound
      if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
        report.audio.outbound = {
          bytesSent: stat.bytesSent,
          packetsSent: stat.packetsSent,
          audioLevel: stat.audioLevel
        };
      }

      // Video inbound
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
        report.video.inbound = {
          bytesReceived: stat.bytesReceived,
          packetsReceived: stat.packetsReceived,
          packetsLost: stat.packetsLost,
          framesDecoded: stat.framesDecoded,
          framesPerSecond: stat.framesPerSecond,
          jitter: stat.jitter
        };
      }

      // Video outbound
      if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
        report.video.outbound = {
          bytesSent: stat.bytesSent,
          packetsSent: stat.packetsSent,
          framesEncoded: stat.framesEncoded,
          framesPerSecond: stat.framesPerSecond
        };
      }

      // Connection quality
      if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
        report.connection = {
          currentRoundTripTime: stat.currentRoundTripTime,
          availableOutgoingBitrate: stat.availableOutgoingBitrate,
          availableIncomingBitrate: stat.availableIncomingBitrate,
          totalRoundTripTime: stat.totalRoundTripTime,
          responsesReceived: stat.responsesReceived
        };
      }

      // ICE candidates
      if (stat.type === 'candidate') {
        report.candidates.push({
          type: stat.type,
          protocol: stat.protocol,
          address: stat.address,
          port: stat.port,
          priority: stat.priority,
          foundation: stat.foundation
        });
      }
    });

    return report;
  } catch (error) {
    console.error('Error getting connection stats:', error);
    return null;
  }
}

// === Stats Monitoring ===
let statsInterval;

function startStatsMonitoring(intervalMs = 1000) {
  if (statsInterval) {
    clearInterval(statsInterval);
  }

  statsInterval = setInterval(async () => {
    const stats = await getConnectionStats();
    if (stats) {
      emitEvent('stats-updated', stats);

      // Log key metrics
      if (stats.connection.currentRoundTripTime) {
        console.log(
          `RTT: ${(stats.connection.currentRoundTripTime * 1000).toFixed(0)}ms, ` +
          `Bandwidth: ${(stats.connection.availableOutgoingBitrate / 1000).toFixed(0)}kbps`
        );
      }

      if (stats.video.inbound.framesPerSecond) {
        console.log(
          `Video FPS: ${stats.video.inbound.framesPerSecond}, ` +
          `Loss: ${stats.video.inbound.packetsLost}/${stats.video.inbound.packetsReceived}`
        );
      }
    }
  }, intervalMs);
}

function stopStatsMonitoring() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

// === Cleanup ===
function endCall() {
  try {
    stopStatsMonitoring();

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }

    if (signalingSocket) {
      signalingSocket.close();
      signalingSocket = null;
    }

    console.log('Call ended');
    emitEvent('call-ended');
  } catch (error) {
    console.error('Error ending call:', error);
    emitEvent('error', { error, type: 'cleanup' });
  }
}

// === Event Emitter ===
const eventListeners = new Map();

function on(eventName, callback) {
  if (!eventListeners.has(eventName)) {
    eventListeners.set(eventName, []);
  }
  eventListeners.get(eventName).push(callback);
}

function off(eventName, callback) {
  if (eventListeners.has(eventName)) {
    const listeners = eventListeners.get(eventName);
    const index = listeners.indexOf(callback);
    if (index > -1) {
      listeners.splice(index, 1);
    }
  }
}

function emitEvent(eventName, data = null) {
  if (eventListeners.has(eventName)) {
    eventListeners.get(eventName).forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Error in event listener for ${eventName}:`, error);
      }
    });
  }
}

// === Exports ===
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    initializePeerConnection,
    setupSignaling,
    startCall,
    sendMessage,
    endCall,
    getConnectionStats,
    startStatsMonitoring,
    stopStatsMonitoring,
    on,
    off,
    emitEvent
  };
}
