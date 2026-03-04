import { build } from 'esbuild'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'

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
writeFileSync('bundle.js', parts.join('\n'))

console.log('Build complete: bundle.js')
