import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addPortMapping, deletePortMapping } from './upnp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HTTP_PORT  = 3000
const HTTPS_PORT = 3443

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.md':   'text/markdown',
  '.css':  'text/css',
  '.json': 'application/json',
}

/** Read JSON body from a request */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => data += c)
    req.on('end', () => {
      try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
    })
  })
}

function requestHandler(req, res) {
  // UPnP port forwarding — POST to add, DELETE to remove
  if (req.url === '/upnp/forward' && req.method === 'POST') {
    readJsonBody(req).then(async ({ externalPort, internalPort }) => {
      const internalIp = getLanIp()
      if (!internalIp) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'No LAN IP detected' }))
        return
      }
      try {
        await addPortMapping(externalPort, internalPort, internalIp, 300)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, externalPort, internalPort, internalIp }))
      } catch (e) {
        console.error('[UPnP] addPortMapping error:', e.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    }).catch(() => { res.writeHead(400); res.end('Bad JSON') })
    return
  }

  if (req.url === '/upnp/forward' && req.method === 'DELETE') {
    readJsonBody(req).then(async ({ externalPort }) => {
      try {
        await deletePortMapping(externalPort)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, externalPort }))
      } catch (e) {
        console.error('[UPnP] deletePortMapping error:', e.message)
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    }).catch(() => { res.writeHead(400); res.end('Bad JSON') })
    return
  }

  // Proxy /woc/* to WhatsOnChain API
  if (req.url.startsWith('/woc/')) {
    const apiPath = req.url.slice(4) // strip "/woc"
    const options = {
      hostname: 'api.whatsonchain.com',
      path: apiPath,
      method: req.method,
      headers: {
        'Accept': req.headers.accept || '*/*',
        'User-Agent': 'SVphone-Prototype/1.0',
      },
    }

    if (req.headers['content-type']) {
      options.headers['Content-Type'] = req.headers['content-type']
    }

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      })
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message)
      res.writeHead(502)
      res.end('Proxy error')
    })

    req.pipe(proxyReq)
    return
  }

  // Static file serving
  const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url)
  const ext = path.extname(filePath)

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' }
    // Prevent caching of JS bundles during development
    if (ext === '.js' || ext === '.html') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    }
    res.writeHead(200, headers)
    res.end(data)
  })
}

// Detect LAN IP for display
function getLanIp() {
  const interfaces = os.networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return null
}

// Start HTTP server (localhost only — secure context for Mac Mini)
http.createServer(requestHandler).listen(HTTP_PORT)

// Start HTTPS server if cert/key files exist (LAN access — secure context for other devices)
const certPath = path.join(__dirname, 'cert.pem')
const keyPath  = path.join(__dirname, 'key.pem')

const lanIp = getLanIp()

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const sslOptions = {
    cert: fs.readFileSync(certPath),
    key:  fs.readFileSync(keyPath),
  }
  https.createServer(sslOptions, requestHandler).listen(HTTPS_PORT, () => {
    console.log(`\n📱 SVphone v09.00 Dev Server`)
    console.log(`${'═'.repeat(50)}`)
    console.log(`HTTP  → http://localhost:${HTTP_PORT}   (this machine)`)
    console.log(`HTTPS → https://${lanIp ?? '?'}:${HTTPS_PORT}  (other devices on LAN)`)
    console.log(`\nPress Ctrl+C to stop\n`)
  })
} else {
  console.log(`\n📱 SVphone v09.00 Dev Server`)
  console.log(`${'═'.repeat(50)}`)
  console.log(`HTTP  → http://localhost:${HTTP_PORT}`)
  if (lanIp) {
    console.log(`\n⚠️  No cert.pem/key.pem found — HTTPS disabled`)
    console.log(`   Other devices on ${lanIp} cannot access microphone/camera`)
    console.log(`\n   To enable HTTPS, run from this directory:`)
    console.log(`   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \\`)
    console.log(`     -sha256 -days 365 -nodes \\`)
    console.log(`     -subj '/CN=SVphone-Dev' \\`)
    console.log(`     -addext "subjectAltName=IP:${lanIp},IP:127.0.0.1,DNS:localhost"`)
    console.log(`   Then restart the server.\n`)
  }
  console.log(`\nPress Ctrl+C to stop\n`)
}
