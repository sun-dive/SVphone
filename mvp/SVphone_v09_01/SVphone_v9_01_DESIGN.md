# SVphone v09.01 Design — 1-TX Call Protocol with ADF Pre-Punch

## Summary

SVphone v09.01 builds on the v09.00 1-TX call protocol and replaces UPnP port forwarding with a pure-browser **ADF pre-punch** mechanism. When the caller has Address-Dependent Filtering (ADF) NAT, the caller injects the callee's known public IP as a remote ICE candidate after setting the synthetic answer. This causes the caller's ICE agent to send a STUN Binding Request to the callee's IP, creating a NAT mapping that allows the callee's subsequent ICE checks to pass through.

This approach requires no local server, no Node.js, and no UPnP — it runs entirely in the browser, preserving the serverless P2P design.

## What Changed from v09.00

| Aspect | v09.00 | v09.01 |
|--------|--------|--------|
| ADF NAT traversal | UPnP via local Node.js server | ADF pre-punch via ICE candidate injection |
| Contact format | `ADDRESS:sha-256:FP` | `ADDRESS:sha-256:FP@IP` (IP optional) |
| Contact storage | Plain fingerprint string | JSON `{fingerprint, ip}` (backward-compat) |
| Server dependency | `serve.mjs` + `upnp.mjs` required for ADF | None — pure browser |
| Files removed | — | `upnp.mjs` deleted |
| Files modified | — | `contacts_store.js`, `call_manager.js`, `phone-controller.js`, `serve.mjs` |

## Core Concepts

### Persistent DTLS Certificate

Each device generates one ECDSA P-256 DTLS certificate and stores it in IndexedDB (`DtlsCertStore`). The SHA-256 fingerprint of this certificate is the device's **call identity** — it stays stable across sessions and browser restarts.

### Contact Format with IP

Contacts are stored as `address → {fingerprint, ip}` pairs in localStorage (`ContactsStore`). The identity string format shared out-of-band:

```
<BSV_ADDRESS>:sha-256:<COLON-SEPARATED-HEX>@<PUBLIC_IP>
```

Examples:
```
1AaBbCc...:sha-256:AB:CD:EF:01:23:45:...@114.39.225.252    (with IP)
1AaBbCc...:sha-256:AB:CD:EF:01:23:45:...                    (without IP — backward compatible)
```

The `@` separator is unambiguous because fingerprint hex only contains `[0-9A-F:]`.

**Why include IP?** The callee's public IP is needed for ADF pre-punch. Including it in the contact string means no server-side IP lookup is required. The IP is auto-appended when the user copies their identity string.

**Stale IP:** If the callee's IP changes after contact exchange, the pre-punch targets the wrong host. This is harmless — the call falls back to normal ICE behavior (works on non-ADF NATs, fails on ADF with stale IP). Users can re-share identity strings to update. Broadband IPs are relatively stable, and broadband is exactly the ADF case.

**Internal storage:** JSON format `{"fingerprint":"sha-256 AB:CD:...","ip":"114.39.225.252"}` with backward-compatible reading of old plain-string values from v09.00.

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

### ADF Pre-Punch (new in v09.01)

**The problem:** Some home routers use Address-Dependent Filtering (ADF). They only accept incoming UDP packets from IP addresses the device has previously sent to. Since the caller only sent STUN packets to Google's server, packets from the callee's IP are dropped even though the correct port is open.

**The solution:** After setting the synthetic answer, the caller injects the callee's known public IP as a remote ICE candidate via `addIceCandidate()`. This creates a candidate pair, causing the caller's ICE agent to send a STUN Binding Request to `calleeIp:3478`.

This packet exits the caller's NAT, creating a mapping that says: "allow incoming packets from `calleeIp`". When the callee picks up the CALL TX and fires real ICE checks from that same IP, the ADF NAT allows them through.

**Key details:**
- The candidate uses `typ srflx raddr 0.0.0.0 rport 0` format (accepted by all browsers)
- Port 3478 is used as a dummy destination — for ADF, only the destination IP matters, not the port
- The STUN check will timeout (callee isn't listening on 3478), but the NAT pinhole is already created
- If the callee's IP in contacts is stale, the pre-punch goes to the wrong host — no harm, just no benefit
- If no IP is stored for the callee, pre-punch is skipped (same behavior as v09.00 without UPnP)

**RFC 4787 NAT behavior types and pre-punch coverage:**

| NAT Filtering Type | Behavior | Pre-punch needed? |
|---|---|---|
| Endpoint-Independent (EIF) | Accepts from any source | No — works without pre-punch |
| Address-Dependent (ADF) | Accepts from IPs the device sent to | Yes — pre-punch opens for callee's IP |
| Address+Port-Dependent (APDF) | Accepts from exact IP:port sent to | Pre-punch opens for IP; port must also match (unlikely with APDF, typically CGNAT) |

## Call Flows

### 1-TX Call (callee fingerprint in contacts)

```
CALLER                                          CALLEE
------                                          ------

1. contactsStore.get(calleeAddress)
   -> { fingerprint, ip }

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

8. ADF PRE-PUNCH:
   if calleeIp is known:
     addIceCandidate({
       calleeIp:3478 typ srflx
     })
     -> ICE sends STUN check to calleeIp
     -> Caller's ADF NAT creates mapping
        for calleeIp

9. Broadcast CALL TX --------------------------> 10. Polling detects CALL TX
   (offer SDP + callerFingerprint                    addressed to my address
    + sessionKey + senderIp)
                                                 11. iceCredentials.deriveAll(sessionKey)
                                                     -> same iceCreds

                                                 12. createAnswerMunged(caller, offerSdp,
                                                     iceCreds)
                                                     -> setRemoteDescription(offer)
                                                       [offer contains caller srflx]
                                                     -> createAnswer()
                                                     -> munge with calleeUfrag/calleePwd
                                                     -> setLocalDescription(mungedAnswer)

                                                 13. ICE agent sees caller's srflx
                                                     candidates from offer
                                                     -> sends connectivity checks
                                                       directly to caller's
                                                       public IP:port

14. Caller's NAT forwards packet              <-- 13. (continued) UDP packet
    ADF allows it because pre-punch                 arrives at caller's srflx
    created mapping for callee's IP                 address

15. ICE agent creates peer-reflexive
    candidate for callee
    -> now knows callee's public IP:port
    -> sends connectivity check back -----------> 16. ICE check arrives at callee

17. ICE connected (both sides)                  17. ICE connected (both sides)
    -> DTLS handshake using                         -> DTLS handshake using
      persistent certificates                         persistent certificates
    -> SRTP media flows                             -> SRTP media flows
```

**Key point:** The callee does NOT query a STUN server. It contacts the caller directly using the IP:port from the offer SDP. The ADF pre-punch at step 8 ensures the caller's NAT is open for the callee's IP before the callee even picks up the call.

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

The synthetic answer sets `a=setup:active` (callee = DTLS client). This matches the browser's default `createAnswer()` behavior. The caller's offer has `a=setup:actpass`, so the caller becomes the DTLS server.

## NAT Traversal

### Caller side (STUN required)

The caller queries a STUN server (e.g. `stun:stun.l.google.com:19302`) during ICE gathering. The STUN response provides the caller's public IP and mapped UDP port as server-reflexive (srflx) candidates. These are embedded in the offer SDP.

The STUN binding creates a NAT mapping: `internalIP:port -> publicIP:mappedPort`. This mapping keeps the port open for a short time, allowing the callee's packets to reach the caller.

### Callee side (no STUN needed)

The callee receives the caller's offer SDP containing srflx candidates with the caller's public IP:port. When the callee calls `setRemoteDescription(offer)`, the browser's ICE agent sends connectivity checks directly to those addresses.

The callee's ICE checks are **peer-to-peer**, not STUN server queries. No STUN server is involved on the callee side.

### ADF pre-punch (replaces UPnP from v09.00)

**How ADF blocks calls without pre-punch:**

1. Caller queries STUN → gets srflx with external port P
2. The NAT mapping for port P was created for destination = STUN server
3. Callee sends ICE check to caller's srflx (port P), from callee's IP
4. Caller's ADF NAT checks: "has the device sent to this source IP before?" → No
5. Packet dropped. ICE fails.

**How pre-punch fixes it:**

1. After setting synthetic answer, caller calls `addIceCandidate(calleeIp:3478)`
2. Caller's ICE sends a STUN Binding Request to `calleeIp:3478`
3. This packet exits the caller's NAT → NAT creates mapping: "allow packets from calleeIp"
4. The STUN check times out (callee isn't listening on 3478) — doesn't matter
5. When callee picks up and sends real ICE checks from `calleeIp`, NAT allows them through
6. ICE connects normally

**Why this works:** ADF filtering is per-IP, not per-IP:port. Any outbound packet to `calleeIp` (regardless of port) opens the NAT filter for all incoming packets from that IP.

**Why port 3478?** It's a dummy port — the callee isn't listening on it. The only purpose of the packet is to create a NAT mapping. Port 3478 (STUN) is chosen as a conventional placeholder.

### CGNAT (Carrier-Grade NAT) — Mobile Data

Mobile carriers place phones behind CGNAT, which typically implements **symmetric NAT** (Port-Dependent Mapping). The external port depends on both source and destination — a STUN query returns port P, but sending to a different destination gets a completely different port.

Confirmed during testing: phone's STUN external port was 59805, but the port seen by the Mac was 61479.

**Broadband-as-caller, phone-as-callee (works):**

1. Mac (broadband, EIM) has stable srflx port regardless of destination
2. Mac broadcasts CALL TX with srflx candidates
3. ADF pre-punch: Mac sends STUN check to phone's known IP (from contacts)
4. Phone receives CALL TX, sends ICE checks to Mac's srflx address
5. Mac's NAT allows the packets (pre-punch created mapping for phone's IP)
6. Mac discovers phone's public IP:port as peer-reflexive, sends reply
7. Phone's CGNAT forwards the reply (outbound mapping exists)
8. ICE connected

**Phone-as-caller (fails — symmetric NAT):**

1. Phone queries STUN → gets srflx port P (mapped for STUN server only)
2. Callee sends ICE checks to port P → CGNAT drops them (mapping is for STUN server IP only)
3. Pre-punch cannot help: CGNAT assigns different ports per destination (Port-Dependent Mapping), so the srflx port itself is wrong, not just the ADF filter

**Phone-to-phone (both on CGNAT — fails):**

Both sides have symmetric NAT. Neither side's srflx port is valid for the other. Only a TURN relay could bridge two symmetric NATs.

### Compatibility matrix

```
Caller              Callee              Result
──────────────────  ──────────────────  ──────────────────────────
Broadband (EIF)     Phone (CGNAT)       Works (1-TX, no pre-punch needed)
Broadband (ADF)     Phone (CGNAT)       Works with pre-punch (1-TX)
Broadband (ADF)     Broadband (EIF)     Works with pre-punch (1-TX)
Broadband (ADF)     Broadband (ADF)     Works with mutual pre-punch (1-TX)
Phone (CGNAT)       Broadband           Fails (symmetric NAT, srflx invalid)
Phone (CGNAT)       Phone (CGNAT)       Fails (both symmetric)
LAN                 LAN                 Works (host candidates)
```

**v09.01 improvement over v09.00:** The `Broadband+ADF → any` row now works without UPnP or any local server. The pre-punch is pure browser code.

**Future:** A TURN relay fallback would enable phone-as-caller and phone-to-phone scenarios.

### LAN calls

On a local network, both peers have direct IP connectivity. STUN is not needed — host candidates in the offer SDP provide the caller's LAN IP:port directly.

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
- Output 0: OP_RETURN (0 sats) — binary encoded call data
- Output 1: P2PKH 1-sat to recipient (callee for CALL/CXID, caller for ANS)
- Output 2: P2PKH change to sender

## File Structure

```
mvp/SVphone_v09_01/
  serve.mjs              -- Dev server (static files + WoC proxy, no UPnP)
  src/
  dtls_cert_store.js     -- IndexedDB persistent ECDSA RTCCertificate
  contacts_store.js      -- localStorage address -> {fingerprint, ip} map
  ice_credentials.js     -- HMAC-SHA256 ICE ufrag/pwd derivation + SDP munging
  synthetic_sdp.js       -- Build callee answer SDP on caller side
  sv_connect/
    call_manager.js      -- Call lifecycle: 1-TX, ADF pre-punch, identity exchange
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

**Removed from v09.00:** `upnp.mjs` (UPnP IGD client) — no longer needed.

## Security Model

- **DTLS-SRTP**: All media encrypted end-to-end. Browser handles cipher negotiation.
- **Fingerprint verification**: Caller uses callee's fingerprint from contacts in the synthetic answer. The DTLS handshake verifies the callee's certificate matches. If a MITM substitutes a different certificate, the handshake fails.
- **ICE credential binding**: Derived from the session key via HMAC-SHA256. Only someone with the session key (in the CALL token) can produce valid ICE credentials.
- **Identity exchange**: Fingerprints are exchanged via blockchain inscriptions. The BSV address provides sender authentication (only the address owner can spend the UTXO to create the inscription).
- **IP in contacts**: The public IP in the contact string is used only for ADF pre-punch. It is shared out-of-band (same as the fingerprint). A stale or incorrect IP causes the pre-punch to target the wrong host — the call may fail on ADF NATs but no security property is compromised. The IP is already publicly visible in the on-chain CALL TX (senderIp field).

## Limitations

- **NAT compatibility**: The 1-TX flow requires the caller's NAT to have Endpoint-Independent Mapping (EIM) so the srflx port is valid for any destination. ADF filtering is handled by pre-punch if the callee's IP is in contacts. Mobile CGNAT (symmetric NAT) cannot be the caller — the srflx port is only valid for the STUN server. A TURN relay would be needed for phone-as-caller or phone-to-phone calls.
- **Stale IP**: If the callee's public IP changes after contact exchange, ADF pre-punch targets the wrong host. The call fails on ADF NATs. Users need to re-share identity strings. Broadband IPs are typically stable.
- **Single device per address**: The persistent DTLS certificate ties a fingerprint to one device. Calling the same address from a different device requires a new identity exchange.
- **Contact exchange required**: The 1-TX path only works after fingerprints have been exchanged. First-time callers must complete the CXID identity exchange (2 transactions) before making a real call.
