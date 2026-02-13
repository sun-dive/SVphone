/**
 * WebRTC P2P Signaling Server (Latest Standard)
 *
 * Simple signaling relay server for WebRTC P2P connections.
 * Source: Comprehensive Research on WebRTC (February 2026)
 *
 * Features:
 * - Relay SDP offers/answers between peers
 * - Forward ICE candidates
 * - Secure WSS (WebSocket Secure) with TLS
 * - Peer registry and message routing
 * - Connection monitoring and cleanup
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

// === Configuration ===
const PORT = process.env.PORT || 443;
const TLS_CERT = process.env.TLS_CERT || './cert.pem';
const TLS_KEY = process.env.TLS_KEY || './key.pem';

// Enable TLS for production
let httpsServer;
try {
  if (fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
    httpsServer = https.createServer({
      cert: fs.readFileSync(TLS_CERT),
      key: fs.readFileSync(TLS_KEY)
    });
    console.log('✓ TLS enabled (WSS)');
  } else {
    console.warn('⚠ TLS certificates not found. For production, use WSS with valid certificates.');
    // Fallback to http (not recommended for production)
    const http = require('http');
    httpsServer = http.createServer();
  }
} catch (error) {
  console.error('Error loading TLS certificates:', error);
  process.exit(1);
}

// === WebSocket Server ===
const wss = new WebSocket.Server({ server: httpsServer });

// === Peer Registry ===
const peers = new Map(); // Map<peerId, { ws, data }>
const peerRooms = new Map(); // Map<roomId, Set<peerId>>

// === Connection Handler ===
wss.on('connection', (ws) => {
  const peerId = generatePeerId();
  let currentRoom = null;
  let peerInfo = {
    id: peerId,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    remoteAddress: ws._socket.remoteAddress,
    messages: 0
  };

  peers.set(peerId, { ws, data: peerInfo });

  console.log(`[${peerId}] Connected from ${ws._socket.remoteAddress}`);
  logStats();

  // === Message Handler ===
  ws.on('message', (data) => {
    try {
      peerInfo.lastSeen = Date.now();
      peerInfo.messages++;

      const message = JSON.parse(data);

      // Validate message
      if (!message.type) {
        console.warn(`[${peerId}] Invalid message: missing type`);
        return;
      }

      // Route message
      switch (message.type) {
        case 'register':
          handleRegister(peerId, message);
          break;

        case 'offer':
        case 'answer':
          handleSDP(peerId, message);
          break;

        case 'ice-candidate':
          handleICECandidate(peerId, message);
          break;

        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;

        case 'leave':
          handleLeaveRoom(peerId, currentRoom);
          break;

        default:
          console.warn(`[${peerId}] Unknown message type: ${message.type}`);
      }

    } catch (error) {
      console.error(`[${peerId}] Error handling message:`, error);
    }
  });

  // === Close Handler ===
  ws.on('close', () => {
    console.log(`[${peerId}] Disconnected`);

    // Clean up rooms
    if (currentRoom) {
      handleLeaveRoom(peerId, currentRoom);
    }

    // Remove from registry
    peers.delete(peerId);

    logStats();
  });

  // === Error Handler ===
  ws.on('error', (error) => {
    console.error(`[${peerId}] WebSocket error:`, error);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    peerId,
    timestamp: Date.now()
  }));
});

// === Message Handlers ===

/**
 * Handle peer registration and room joining
 */
function handleRegister(peerId, message) {
  const { room, name } = message;

  if (!room) {
    console.warn(`[${peerId}] Register: missing room`);
    return;
  }

  const peerData = peers.get(peerId);
  if (!peerData) return;

  // Leave previous room if any
  if (peerData.data.room) {
    handleLeaveRoom(peerId, peerData.data.room);
  }

  // Join new room
  if (!peerRooms.has(room)) {
    peerRooms.set(room, new Set());
  }

  peerRooms.get(room).add(peerId);
  peerData.data.room = room;
  peerData.data.name = name || `Peer-${peerId.slice(0, 4)}`;

  // Send registered confirmation
  peerData.ws.send(JSON.stringify({
    type: 'registered',
    room,
    peerId,
    name: peerData.data.name,
    timestamp: Date.now()
  }));

  // Notify others in room
  broadcastToRoom(room, {
    type: 'peer-joined',
    peerId,
    name: peerData.data.name,
    participantCount: peerRooms.get(room).size
  }, peerId);

  console.log(`[${peerId}] Joined room: ${room} as "${peerData.data.name}"`);
}

/**
 * Handle SDP offer/answer relay
 */
function handleSDP(peerId, message) {
  const { to, sdp, type } = message;

  if (!to) {
    console.warn(`[${peerId}] SDP: missing recipient`);
    return;
  }

  const targetPeer = peers.get(to);
  if (!targetPeer) {
    console.warn(`[${peerId}] SDP: target peer not found: ${to}`);
    return;
  }

  // Forward SDP to target
  targetPeer.ws.send(JSON.stringify({
    type,
    from: peerId,
    sdp,
    timestamp: Date.now()
  }));

  console.log(`[${peerId}] Sent ${type} to ${to.slice(0, 8)}`);
}

/**
 * Handle ICE candidate relay
 */
function handleICECandidate(peerId, message) {
  const { to, candidate } = message;

  if (!to) {
    console.warn(`[${peerId}] ICE: missing recipient`);
    return;
  }

  const targetPeer = peers.get(to);
  if (!targetPeer) {
    console.warn(`[${peerId}] ICE: target peer not found: ${to}`);
    return;
  }

  // Forward candidate to target
  targetPeer.ws.send(JSON.stringify({
    type: 'ice-candidate',
    from: peerId,
    candidate,
    timestamp: Date.now()
  }));
}

/**
 * Handle peer leaving room
 */
function handleLeaveRoom(peerId, room) {
  if (!room) return;

  const roomMembers = peerRooms.get(room);
  if (roomMembers) {
    roomMembers.delete(peerId);

    // Notify others
    broadcastToRoom(room, {
      type: 'peer-left',
      peerId,
      participantCount: roomMembers.size
    });

    // Clean up empty rooms
    if (roomMembers.size === 0) {
      peerRooms.delete(room);
    }

    const peerData = peers.get(peerId);
    if (peerData) {
      peerData.data.room = null;
    }

    console.log(`[${peerId}] Left room: ${room}`);
  }
}

// === Utility Functions ===

/**
 * Broadcast message to all peers in a room
 */
function broadcastToRoom(room, message, excludePeerId = null) {
  const roomMembers = peerRooms.get(room);
  if (!roomMembers) return;

  const messageStr = JSON.stringify(message);

  roomMembers.forEach(peerId => {
    if (peerId === excludePeerId) return;

    const peerData = peers.get(peerId);
    if (peerData && peerData.ws.readyState === WebSocket.OPEN) {
      peerData.ws.send(messageStr);
    }
  });
}

/**
 * Generate unique peer ID
 */
function generatePeerId() {
  return `peer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Log server statistics
 */
function logStats() {
  const stats = {
    connectedPeers: peers.size,
    activeRooms: peerRooms.size,
    timestamp: new Date().toISOString()
  };

  // Calculate room statistics
  let totalInRooms = 0;
  peerRooms.forEach((members) => {
    totalInRooms += members.size;
  });

  stats.peersInRooms = totalInRooms;

  console.log(`[STATS] ${JSON.stringify(stats)}`);
}

/**
 * Periodic cleanup of stale connections
 */
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const STALE_TIMEOUT = 90000; // 90 seconds

setInterval(() => {
  const now = Date.now();
  const staleThreshold = now - STALE_TIMEOUT;

  let cleaned = 0;
  peers.forEach((peerData, peerId) => {
    if (peerData.data.lastSeen < staleThreshold) {
      console.warn(`[${peerId}] Closing stale connection (inactive for ${STALE_TIMEOUT}ms)`);
      peerData.ws.close(1000, 'Stale connection');
      cleaned++;
    } else {
      // Send heartbeat ping
      if (peerData.ws.readyState === WebSocket.OPEN) {
        peerData.ws.send(JSON.stringify({
          type: 'ping',
          timestamp: now
        }));
      }
    }
  });

  if (cleaned > 0) {
    console.log(`[CLEANUP] Closed ${cleaned} stale connections`);
    logStats();
  }
}, HEARTBEAT_INTERVAL);

// === Server Startup ===
httpsServer.listen(PORT, () => {
  console.log(`✓ WebRTC Signaling Server listening on port ${PORT}`);
  console.log(`  Protocol: ${fs.existsSync(TLS_CERT) ? 'WSS (Secure)' : 'WS (Insecure)'}`);
  console.log(`  Active connections: 0`);
});

// === Graceful Shutdown ===
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');

  // Close all peer connections
  peers.forEach((peerData) => {
    peerData.ws.close(1001, 'Server shutting down');
  });

  // Close server
  httpsServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit after timeout
  setTimeout(() => {
    console.error('Forced shutdown timeout');
    process.exit(1);
  }, 10000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.emit('SIGTERM');
});

// === Exports ===
module.exports = { wss, peers, peerRooms };
