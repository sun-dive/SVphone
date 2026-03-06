/**
 * SVphone STUN Server (RFC 5389 Binding Request only)
 *
 * Handles STUN Binding Requests over UDP and responds with the client's
 * public IP:port (XOR-MAPPED-ADDRESS). This allows WebRTC ICE agents
 * behind NAT/CGNAT to discover their real public endpoint.
 *
 * Deploy on svphone.com and run with: node stun-server.js
 * Configure firewall to allow UDP inbound on port 3478.
 *
 * ICE config in peer_connection.js: { urls: 'stun:svphone.com:3478' }
 */

const dgram = require('dgram')

const PORT = parseInt(process.env.STUN_PORT || '3478', 10)
const MAGIC_COOKIE = 0x2112A442

const server = dgram.createSocket({ type: 'udp4', reuseAddr: true })

server.on('message', (msg, rinfo) => {
  // Minimum STUN message is 20 bytes
  if (msg.length < 20) return

  // Verify STUN magic cookie at bytes 4-7
  if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return

  // Only handle Binding Request (type 0x0001)
  const msgType = msg.readUInt16BE(0)
  if (msgType !== 0x0001) return

  const txId = msg.slice(8, 20) // 12-byte transaction ID

  // Parse client IPv4
  const ipParts = rinfo.address.split('.').map(Number)
  const ipInt = (ipParts[0] << 24 | ipParts[1] << 16 | ipParts[2] << 8 | ipParts[3]) >>> 0
  const port = rinfo.port

  // XOR-MAPPED-ADDRESS attribute (type 0x0020, length 8)
  // Port XOR'd with high 16 bits of magic cookie
  // IP XOR'd with magic cookie
  const xorPort = port ^ (MAGIC_COOKIE >>> 16)
  const xorIp = ipInt ^ MAGIC_COOKIE

  // Build Binding Response: 20-byte header + 12-byte XOR-MAPPED-ADDRESS
  const resp = Buffer.alloc(32)
  resp.writeUInt16BE(0x0101, 0)      // Message type: Binding Response
  resp.writeUInt16BE(12, 2)          // Message length (attributes only)
  resp.writeUInt32BE(MAGIC_COOKIE, 4)
  txId.copy(resp, 8)                 // Transaction ID (echo back)

  // XOR-MAPPED-ADDRESS attribute
  resp.writeUInt16BE(0x0020, 20)     // Attribute type
  resp.writeUInt16BE(8, 22)          // Attribute length
  resp.writeUInt8(0x00, 24)          // Reserved
  resp.writeUInt8(0x01, 25)          // Address family: IPv4
  resp.writeUInt16BE(xorPort, 26)
  resp.writeUInt32BE(xorIp, 28)

  server.send(resp, rinfo.port, rinfo.address, (err) => {
    if (err) console.error(`[STUN] Send error to ${rinfo.address}:${rinfo.port}:`, err.message)
  })
})

server.on('error', (err) => {
  console.error('[STUN] Server error:', err.message)
  process.exit(1)
})

server.on('listening', () => {
  const addr = server.address()
  console.log(`[STUN] Listening on UDP ${addr.address}:${addr.port}`)
})

server.bind(PORT)
