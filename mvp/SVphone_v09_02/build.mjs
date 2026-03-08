import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'

const VERSION    = 'v09.02'
const BUILD_TIME = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

// Step 1: Build TypeScript/BSV SDK bundle
await build({
  entryPoints: ['src/app.ts'],
  bundle: true,
  outfile: 'bundle.tmp.js',
  platform: 'browser',
  format: 'iife',
  sourcemap: false,
  target: 'es2020',
  define: { 'global': 'window' },
})

// Step 2: Plain JS files for phone interface (load order matters)
const phoneFiles = [
  'src/dtls_cert_store.js',             // 1-TX: persistent DTLS certificate (IndexedDB)
  'src/contacts_store.js',              // 1-TX: address → fingerprint contact book
  'src/ice_credentials.js',             // 1-TX: HMAC-SHA256 ICE credential derivation
  'src/synthetic_sdp.js',               // 1-TX: build callee answer SDP on caller side
  'src/sv_connect/signaling.js',
  'src/sv_connect/microphone_tester.js',
  'src/sv_connect/camera_tester.js',
  'src/sv_connect/call_manager.js',     // defines EventEmitter
  'src/sv_connect/peer_connection.js',  // extends EventEmitter
  'src/sv_connect/codec_negotiation.js',
  'src/sv_connect/quality_adaptation.js',
  'src/sv_connect/media_security.js',
  'src/sv_connect/call_token.js',
  'src/phone-ui.js',
  'src/phone-handlers.js',
  'src/phone-controller.js',
]

// Step 3: Plain JS files for wallet interface
const walletFiles = [
  'src/wallet-ui.js',
  'src/wallet-handlers.js',
]

const tsBundle = readFileSync('bundle.tmp.js', 'utf8')
unlinkSync('bundle.tmp.js')

// bundle.js — everything needed for both phone and wallet interfaces
const parts = [tsBundle]
for (const file of [...phoneFiles, ...walletFiles]) {
  parts.push(readFileSync(file, 'utf8'))
}
const stamp = `window.SVPHONE_VERSION="${VERSION}";window.SVPHONE_BUILD="${BUILD_TIME}";document.addEventListener('DOMContentLoaded',()=>{document.querySelectorAll('[data-svphone-version]').forEach(el=>el.textContent=el.textContent.replace(/v[0-9]+\\.[0-9]+/,'${VERSION}'));const el=document.getElementById('svphone-build');if(el)el.textContent='build: ${VERSION} / ${BUILD_TIME}';});console.log('[SVphone] ${VERSION} Build: ${BUILD_TIME}');`
writeFileSync('bundle.js', [stamp, ...parts].join('\n'))

console.log('Build complete: bundle.js')
