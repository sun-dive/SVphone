# SVphone v09.00 Design — 1-TX Call Protocol

## Summary

SVphone v09.00 establishes voice/video calls using a **single blockchain transaction** (CALL token). The caller embeds everything the callee needs to connect — SDP offer with STUN-derived public IP:port, DTLS fingerprint, and derived ICE credentials — into one OP_RETURN inscription. The callee contacts the caller directly using the IP:port from the offer. No answer token is required.

First-time callers who are not yet in each other's contacts exchange DTLS fingerprints via a lightweight **identity exchange** (CXID token) before the first real call.

## Core Concepts

### Persistent DTLS Certificate

Each device generates one ECDSA P-256 DTLS certificate and stores it in IndexedDB (`DtlsCertStore`). The SHA-256 fingerprint of this certificate is the device's **call identity** — it stays stable across sessions and browser restarts.

Contacts are stored as `address:fingerprint` pairs in localStorage (`ContactsStore`). The identity string format shared out-of-band (paste, QR code, etc.):

```
<BSV_ADDRESS>:sha-256:<COLON-SEPARATED-HEX>
```

Example: `1AaBbCc...:sha-256:AB:CD:EF:01:23:45:...`

### Derived ICE Credentials

Both caller and callee derive identical ICE ufrag/pwd from the shared session key using HMAC-SHA256 (`IceCredentials`):

```
callerUfrag = base64url(HMAC-SHA256(sessionKey, "caller:ufrag")).slice(0, 8)
callerPwd   = base64url(HMAC-SHA256(sessionKey, "caller:pwd")).slice(0, 22)
calleeUfrag = base64url(HMAC-SHA256(sessionKey, "callee:ufrag")).slice(0, 8)
calleePwd   = base64url(HMAC-SHA256(sessionKey, "callee:pwd")).slice(0, 22)
```

The caller munges the offer SDP with `callerUfrag`/`callerPwd` before `setLocalDescription`. The callee derives the same values from the session key in the CALL token and munges its answer with `calleeUfrag`/`calleePwd`. No round-trip needed to agree on credentials.

### Synthetic Answer SDP

The caller builds a synthetic callee answer SDP (`SyntheticSdp`) locally using:
- Callee's DTLS fingerprint (from contacts)
- Callee's derived ICE credentials (`calleeUfrag`/`calleePwd`)
- Media sections mirrored from the offer

The caller calls `setRemoteDescription(syntheticAnswer)` immediately after `setLocalDescription(offer)`. This puts the caller's ICE agent into a listening state — it has no remote candidates to check, so it waits passively for incoming connectivity checks from the callee.

The browser validates DTLS fingerprints during the actual handshake (not during SDP parsing), so the synthetic answer is accepted as long as it is syntactically valid and uses the callee's real certificate fingerprint and derived credentials.

## Call Flows

### 1-TX Call (callee fingerprint in contacts)

```
CALLER                                          CALLEE
------                                          ------

1. contactsStore.get(calleeAddress)
   -> calleeFingerprint (must exist)

2. Generate random 32-byte sessionKey

3. iceCredentials.deriveAll(sessionKey)
   -> { callerUfrag, callerPwd,
      calleeUfrag, calleePwd }

4. createOfferMunged(callee, iceCreds)
   -> SDP offer with callerUfrag/callerPwd
   -> setLocalDescription(mungedOffer)

5. waitForIceGathering()
   -> STUN server returns srflx candidates
   -> Offer SDP now contains public IP:port

6. syntheticSdp.build(offer, calleeUfrag,
   calleePwd, calleeFingerprint)
   -> synthetic answer SDP

7. setRemoteDescription(syntheticAnswer)
   -> ICE agent listening (no remote
     candidates, waits for prflx)

8. Broadcast CALL TX --------------------------> 9. Polling detects CALL TX
   (offer SDP + callerFingerprint                  addressed to my address
    + sessionKey + senderIp)
                                                10. iceCredentials.deriveAll(sessionKey)
                                                    -> same iceCreds

                                                11. createAnswerMunged(caller, offerSdp,
                                                    iceCreds)
                                                    -> setRemoteDescription(offer)
                                                      [offer contains caller srflx]
                                                    -> createAnswer()
                                                    -> munge with calleeUfrag/calleePwd
                                                    -> setLocalDescription(mungedAnswer)

                                                12. ICE agent sees caller's srflx
                                                    candidates from offer
                                                    -> sends connectivity checks
                                                      directly to caller's
                                                      public IP:port

13. Caller's NAT forwards packet              <-- 12. (continued) UDP packet
    (port was opened by STUN binding)              arrives at caller's srflx
                                                   address

14. ICE agent creates peer-reflexive
    candidate for callee
    -> now knows callee's public IP:port
    -> sends connectivity check back -----------> 15. ICE check arrives at callee

16. ICE connected (both sides)                  16. ICE connected (both sides)
    -> DTLS handshake using                         -> DTLS handshake using
      persistent certificates                         persistent certificates
    -> SRTP media flows                             -> SRTP media flows
```

**Key point:** The callee does NOT query a STUN server. It contacts the caller directly using the IP:port information from the offer SDP (the caller's srflx candidates obtained via STUN). When the callee's packet arrives at the caller, the caller discovers the callee's public IP:port as a peer-reflexive candidate.

### Identity Exchange (first-time contact)

When the caller does not have the callee's fingerprint in contacts, no WebRTC connection is attempted. Instead, a lightweight identity exchange trades fingerprints via blockchain tokens:

```
CALLER                                          CALLEE
------                                          ------

1. contactsStore.get(calleeAddress) -> null
   (not in contacts)

2. Broadcast CXID TX --------------------------> 3. Polling detects CXID TX
   (callerFingerprint + empty SDP)                 -> callerFingerprint present,
                                                     SDP empty = identity exchange

   UI: "Exchanging identities..."              4. UI: "Identity exchange from ADDRESS"
                                                   User accepts

                                                5. Save caller to contacts:
                                                   contactsStore.save(caller,
                                                     callerFingerprint)

                                                6. Broadcast ANS TX <--------------
                                                   (calleeFingerprint + empty SDP)

7. Polling detects ANS TX
   -> session.identityExchange = true
   -> calleeFingerprint present

8. Save callee to contacts:
   contactsStore.save(calleeAddress,
     callerFingerprint from ANS)

   UI: "Contact saved! You can now
        call ADDRESS."
```

After identity exchange, both sides have each other's fingerprint in contacts. The next call uses the 1-TX path.

### DTLS Setup Direction

The synthetic answer sets `a=setup:active` (callee = DTLS client). This matches the browser's default `createAnswer()` behavior. The caller's offer has `a=setup:actpass`, so the caller becomes the DTLS server. This ensures the DTLS handshake direction matches on both sides.

## Binary Token Format

OP_RETURN inscription with prefix `CALL-`, `ANS-`, or `CXID-` followed by binary attributes:

```
Byte(s)   Field
-------   -----
[1]       version = 0x01
[1]       IP type: 0x00=IPv4, 0x01=IPv6
[4|16]    IP address bytes
[2]       port (big-endian)
[1+N]     session key (1-byte length + UTF-8)
[1]       codec: 0=opus, 1=pcm, 2=aac
[1]       quality: 0=sd, 1=hd, 2=vhd
[1]       media bitmask: bit0=audio, bit1=video
[2+N]     SDP (2-byte length + UTF-8, empty for CXID)
[1+N]     caller address (1-byte length + UTF-8)
[1+N]     callee address (1-byte length + UTF-8)
[1+4]     senderIp4 (1-byte length: 4=present, 0=absent)
[1+16]    senderIp6 (1-byte length: 16=present, 0=absent)
[1+N]     callerFingerprint (1-byte length + UTF-8)
          "sha-256 AB:CD:..." -- carries caller's fp in CALL/CXID,
          callee's fp in ANS direction
```

TX structure:
- Output 0: OP_RETURN (0 sats) -- binary encoded call data
- Output 1: P2PKH 1-sat to recipient (callee for CALL/CXID, caller for ANS)
- Output 2: P2PKH change to sender

## NAT Traversal

### Caller side (STUN required)

The caller queries a STUN server (e.g. `stun:stun.l.google.com:19302`) during ICE gathering. The STUN response provides the caller's public IP and mapped UDP port as server-reflexive (srflx) candidates. These are embedded in the offer SDP.

The STUN binding creates a NAT mapping: `internalIP:port -> publicIP:mappedPort`. This mapping keeps the port open for a short time, allowing the callee's packets to reach the caller.

### Callee side (no STUN needed)

The callee receives the caller's offer SDP containing srflx candidates with the caller's public IP:port. When the callee calls `setRemoteDescription(offer)`, the browser's ICE agent sends connectivity checks (STUN binding requests) directly to those addresses.

These are **peer-to-peer ICE connectivity checks**, not STUN server queries. The callee sends UDP packets directly to the caller's public IP:port. No STUN server is involved on the callee side.

When the caller's NAT receives these packets on the mapped port, it forwards them to the caller. The caller's ICE agent sees the callee's source address as a peer-reflexive candidate, enabling bidirectional communication.

### LAN calls

On a local network, both peers have direct IP connectivity. STUN is not needed -- host candidates in the offer SDP provide the caller's LAN IP:port directly.

## File Structure

```
mvp/SVphone_v09_00/src/
  dtls_cert_store.js     -- IndexedDB persistent ECDSA RTCCertificate
  contacts_store.js      -- localStorage address->fingerprint map
  ice_credentials.js     -- HMAC-SHA256 ICE ufrag/pwd derivation + SDP munging
  synthetic_sdp.js       -- Build callee answer SDP on caller side
  sv_connect/
    call_manager.js      -- Call lifecycle: 1-TX, identity exchange, events
    signaling.js         -- Blockchain polling, call token create/broadcast
    call_token.js        -- Binary encode/decode for OP_RETURN attributes
    peer_connection.js   -- WebRTC: offer/answer, ICE, media streams
    codec_negotiation.js
    quality_adaptation.js
    media_security.js
  phone-controller.js    -- App init, event binding, UI coordination
  phone-ui.js            -- DOM manipulation, status display
  phone-handlers.js      -- User action handlers (call, accept, reject)
```

## Security Model

- **DTLS-SRTP**: All media encrypted end-to-end. Browser handles cipher negotiation.
- **Fingerprint verification**: Caller uses callee's fingerprint from contacts in the synthetic answer. The DTLS handshake verifies the callee's certificate matches. If a MITM substitutes a different certificate, the handshake fails.
- **ICE credential binding**: Derived from the session key via HMAC-SHA256. Only someone with the session key (in the CALL token) can produce valid ICE credentials.
- **Identity exchange**: Fingerprints are exchanged via blockchain inscriptions. The BSV address provides sender authentication (only the address owner can spend the UTXO to create the inscription).

## Limitations

- **NAT compatibility**: The 1-TX flow requires the caller's NAT to accept packets from the callee on the STUN-mapped port. This works with Endpoint-Independent Mapping (EIM) and Endpoint-Independent or Address-Dependent Filtering. Symmetric NAT (port-dependent mapping/filtering) will block the callee's packets. A TURN relay fallback would be needed for those networks.
- **Single device per address**: The persistent DTLS certificate ties a fingerprint to one device. Calling the same address from a different device requires a new identity exchange.
- **Contact exchange required**: The 1-TX path only works after fingerprints have been exchanged. First-time callers must complete the CXID identity exchange (2 transactions) before making a real call.
