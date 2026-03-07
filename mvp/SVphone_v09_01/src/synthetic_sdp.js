/**
 * Synthetic SDP Builder
 *
 * Builds a callee answer SDP on the caller side, using:
 *   - callee's derived ICE credentials (from session key)
 *   - callee's DTLS fingerprint (from contacts)
 *   - media sections mirrored from the offer
 *
 * This lets the caller call setRemoteDescription(syntheticAnswer) immediately
 * after setLocalDescription(offer), so its ICE agent is listening for
 * peer-reflexive STUN checks from the callee — no ANS token required.
 *
 * The browser validates fingerprint/ICE credentials during the actual DTLS/ICE
 * handshake, not during SDP parsing, so the synthetic SDP is accepted as long
 * as it is syntactically valid and uses callee's real cert and derived creds.
 */
class SyntheticSdp {
  /**
   * Build a synthetic answer SDP.
   * @param {string} offerSdp         - the munged offer SDP (caller's local description)
   * @param {string} calleeUfrag      - callee's derived ICE ufrag
   * @param {string} calleePwd        - callee's derived ICE pwd
   * @param {string} calleeFingerprint - "sha-256 AB:CD:..." from contacts
   * @returns {string} answer SDP
   */
  build(offerSdp, calleeUfrag, calleePwd, calleeFingerprint) {
    const lines   = offerSdp.split(/\r?\n/).filter(l => l.length > 0)
    const answer  = []

    // Session section
    answer.push('v=0')
    answer.push(`o=- ${Date.now()} 1 IN IP4 0.0.0.0`)
    answer.push('s=-')
    answer.push('t=0 0')

    // Copy session-level attributes that the answer must mirror
    for (const line of lines) {
      if (line.startsWith('m=')) break
      if (line.startsWith('a=group:') || line === 'a=extmap-allow-mixed') {
        answer.push(line)
      }
    }

    // Build one answer m-section per offer m-section
    for (const sect of this._parseSections(lines)) {
      answer.push(sect.mLine)          // same m= line (same PTs, port 9 = ignored)
      answer.push('c=IN IP4 0.0.0.0')
      answer.push('a=rtcp:9 IN IP4 0.0.0.0')

      // Derived ICE credentials (must match callee's setLocalDescription)
      answer.push(`a=ice-ufrag:${calleeUfrag}`)
      answer.push(`a=ice-pwd:${calleePwd}`)
      answer.push('a=ice-options:trickle')

      // Callee's DTLS fingerprint (from contacts)
      answer.push(`a=fingerprint:${calleeFingerprint}`)
      answer.push('a=setup:active')       // callee is DTLS client (matches browser createAnswer default)

      // Mirror critical m-section attributes from offer
      let foundDirection = false
      for (const l of sect.attrs) {
        if (
          l.startsWith('a=mid:')     ||
          l === 'a=rtcp-mux'         ||
          l === 'a=rtcp-rsize'       ||
          l.startsWith('a=rtpmap:')  ||
          l.startsWith('a=fmtp:')    ||
          l.startsWith('a=rtcp-fb:') ||
          l.startsWith('a=extmap:')  ||
          l.startsWith('a=sctpmap:') ||
          l.startsWith('a=sctp-port:') ||
          l.startsWith('a=max-message-size:')
        ) {
          answer.push(l)
          continue
        }
        // Mirror media direction
        if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(l)) {
          const map = {
            'a=sendonly':  'a=recvonly',
            'a=recvonly':  'a=sendonly',
            'a=sendrecv':  'a=sendrecv',
            'a=inactive':  'a=inactive',
          }
          answer.push(map[l] || l)
          foundDirection = true
        }
      }
      if (!foundDirection) answer.push('a=sendrecv')
    }

    return answer.join('\r\n') + '\r\n'
  }

  /** @private Split offer SDP into per-m-section objects */
  _parseSections(lines) {
    const sections = []
    let current    = null
    for (const line of lines) {
      if (line.startsWith('m=')) {
        if (current) sections.push(current)
        current = { mLine: line, attrs: [] }
      } else if (current && !line.startsWith('c=')) {
        current.attrs.push(line)
      }
    }
    if (current) sections.push(current)
    return sections
  }
}

if (typeof window !== 'undefined') window.SyntheticSdp = SyntheticSdp
if (typeof module !== 'undefined' && module.exports) module.exports = SyntheticSdp
