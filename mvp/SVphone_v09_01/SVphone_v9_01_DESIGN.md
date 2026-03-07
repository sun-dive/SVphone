# SVphone v09.01 Design — 1-TX Call Protocol with 2-TX Port Discovery

## Summary

SVphone v09.01 builds on the v09.00 1-TX call protocol and replaces UPnP port forwarding with a pure-browser **2-TX port discovery** mechanism for NAT traversal. When one or both peers are behind restrictive NATs, the callee discovers its own public port via STUN and broadcasts a PORT token back to the caller. Both sides then spray ICE candidates at each other's known ports, enabling connectivity without any server-side relay.

This approach requires no local server, no Node.js, and no UPnP — it runs entirely in the browser, preserving the serverless P2P design.

**Successfully tested:** Cross-broadband video call between fast cable and slow ADSL connections.

## What Changed from v09.00

| Aspect | v09.00 | v09.01 |
|--------|--------|--------|
| ADF NAT traversal | UPnP via local Node.js server | 2-TX port discovery + bidirectional spray |
| Contact format | `ADDRESS:sha-256:FP` | `ADDRESS:sha-256:FP@IP` (IP optional) |
| Contact storage | Plain fingerprint string | JSON `{fingerprint, ip}` (backward-compat) |
| Callee port discovery | None (callee didn't know own port) | STUN query with srflx/host fallback |
| Port announcement | None | PORT token (ANS TX with port, no SDP) |
| Caller spray strategy | None | Blind VoIP range → targeted ±20 on PORT arrival |
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

**Why include IP?** The callee's public IP is needed for port spraying. Including it in the contact string means no server-side IP lookup is required. The IP is auto-appended when the user copies their identity string.

**Stale IP:** If the callee's IP changes after contact exchange, port spray targets the wrong host. This is harmless — the call falls back to normal ICE behavior (works on non-ADF NATs, fails on ADF with stale IP). Users can re-share identity strings to update. Broadband IPs are relatively stable, and broadband is exactly the ADF case.

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

### 2-TX Port Discovery (new in v09.01)

**The problem:** Some home routers use Address-Dependent Filtering (ADF). They only accept incoming UDP packets from IP addresses the device has previously sent to. Since the caller only sent STUN packets to Google's server, packets from the callee's IP are dropped even though the correct port is open. Additionally, symmetric NAT allocates different ports per destination, so even with the right IP filter, the port in the offer SDP may not match the port actually used for the callee.

**The solution — a two-phase approach:**

**Phase 1: Blind spray (immediate)**
After setting the synthetic answer, the caller injects the callee's known public IP as 20 remote ICE candidates covering VoIP ports 3478-3497. This causes the caller's ICE agent to send STUN Binding Requests to the callee's IP, creating NAT mappings that allow the callee's subsequent ICE checks to pass through ADF.

**Phase 2: Targeted spray (after PORT token)**
The callee runs its own STUN query to discover its public port, then broadcasts a PORT token (an ANS TX containing only the port — no SDP). When the caller receives this, it stops blind spraying and switches to targeted spray: ±20 ports around the callee's actual port (41 candidates). This covers symmetric NAT port drift.

**Key details:**
- Blind spray fires immediately — no waiting for PORT token
- Callee also sprays ±20 around the caller's known srflx port (from the CALL TX)
- Both sides repeat their spray every 3 seconds until ICE connects
- Port spraying creates `typ srflx` candidates with `raddr 0.0.0.0 rport 0`
- If no IP is stored for the callee, all spraying is skipped (same behavior as v09.00)

### Callee Port Discovery Fallback Chain

The callee discovers its own public port through a three-tier fallback:

1. **STUN srflx** — standard STUN query returns server-reflexive candidate with public IP:port
2. **host-public** — if no srflx (machine has public IP on interface, browser deduplicates per RFC 8445), check if any host candidate's IP matches the known public IP
3. **host-fallback** — if no direct IP match (Chrome uses mDNS hostnames like `xxx.local`), use any host candidate's port combined with the known public IP from HTTP detection

All three paths emit `call:port-discovered`, which triggers the PORT token broadcast.

**Regex note:** Chrome uses lowercase `udp` in SDP candidates (not uppercase `UDP`) and mDNS hostnames instead of IP addresses. The regexes use `\w+` for transport and `\S+` for addresses to handle both.

## Call Flows

### 1-TX Call with 2-TX Port Discovery

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
   -> Extract callerSrflxPort

6. syntheticSdp.build(offer, calleeUfrag,
   calleePwd, calleeFingerprint)
   -> synthetic answer SDP

7. setRemoteDescription(syntheticAnswer)

8. BLIND SPRAY (if calleeIp known):
   _injectPortSpray(calleeIp, null)
   -> 20 candidates: ports 3478-3497
   -> ICE sends STUN checks to calleeIp
   -> Caller's ADF NAT creates mapping
   (repeat every 3s)

9. Broadcast CALL TX --------------------------> 10. Polling detects CALL TX
   (offer SDP + callerFingerprint                    addressed to my address
    + sessionKey + callerSrflxPort
    + senderIp)
                                                 11. _startPrePunch():

                                                 12. iceCredentials.deriveAll(sessionKey)
                                                     -> same iceCreds

                                                 13. createAnswerMunged(caller, offerSdp,
                                                     iceCreds, {iceServers: STUN})
                                                     -> setRemoteDescription(offer)
                                                     -> createAnswer()
                                                     -> munge with calleeUfrag/calleePwd
                                                     -> setLocalDescription(mungedAnswer)

                                                 14. waitForIceGathering()
                                                     -> STUN returns callee's srflx
                                                     -> fallback: host-public or
                                                        host-fallback

                                                 15. CALLEE SPRAY:
                                                     _injectPortSpray(callerIp,
                                                       callerSrflxPort)
                                                     -> 41 candidates: ±20 of
                                                        callerSrflxPort
                                                     (repeat every 3s)

                                                 16. Emit call:port-discovered
                                                     -> Broadcast PORT token --------->
                                                        (ANS TX: port only, no SDP)

17. Receive PORT token
    -> Stop blind spray
    -> TARGETED SPRAY:
       _injectPortSpray(calleeIp,
         calleePort)
       -> 41 candidates: ±20 of calleePort
       (repeat every 3s)

~~~ ICE connectivity checks cross in both directions ~~~

18. ICE connected (both sides)                   18. ICE connected (both sides)
    -> DTLS handshake using                          -> DTLS handshake using
      persistent certificates                          persistent certificates
    -> SRTP media flows                              -> SRTP media flows
    -> Clear spray intervals                         -> Clear spray intervals
```

**Transaction count:** 2 TXs total — one CALL TX (caller→callee) and one PORT TX (callee→caller). The PORT TX is an ANS token with the callee's discovered port but no SDP answer.

**Pre-punch timing:** Steps 11-16 happen immediately when the CALL TX is detected, **before the user clicks Accept**. This minimizes connection delay. When the user accepts, the PeerConnection is already established with ICE credentials and media tracks are added to the existing connection.

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

The caller queries a STUN server (e.g. `stun:stun.l.google.com:19302`) during ICE gathering. The STUN response provides the caller's public IP and mapped UDP port as server-reflexive (srflx) candidates. These are embedded in the offer SDP and the CALL TX's `senderPort` field.

The STUN binding creates a NAT mapping: `internalIP:port -> publicIP:mappedPort`. This mapping keeps the port open for a short time, allowing the callee's packets to reach the caller.

### Callee side (STUN for port discovery)

The callee receives the caller's offer SDP containing srflx candidates with the caller's public IP:port. When the callee calls `setRemoteDescription(offer)`, the browser's ICE agent sends connectivity checks directly to those addresses.

In v09.01, the callee also queries STUN to discover its own public port. This port is broadcast to the caller via a PORT token so the caller can do targeted spraying. If STUN fails to produce srflx candidates, the fallback chain (host-public → host-fallback) provides the port from host candidates combined with the HTTP-detected public IP.

### Port spray — bidirectional NAT punching

**_injectPortSpray(ip, options)** adds synthetic `typ srflx` ICE candidates to punch through NAT:

| Mode | Trigger | Ports sprayed | Candidate count |
|------|---------|---------------|-----------------|
| Blind spray | Caller has calleeIp, no PORT yet | 3478-3497 (VoIP range) | 20 |
| Targeted spray | PORT token received with exact port | port ± 20 | 41 |
| Callee spray | Callee has callerSrflxPort from CALL TX | port ± 20 | 41 |

Both sides repeat spray every 3 seconds. Each batch gets a unique candidate ID (`spray{batch}_{i}`) to avoid deduplication by the ICE agent. Spray intervals are cleared when ICE connects or the call ends.

**Why ±20?** Symmetric NATs allocate sequential ports. A window of ±20 covers typical allocation patterns while keeping candidate count manageable (41 per spray).

**Why blind spray uses VoIP range?** Before the PORT token arrives, the caller doesn't know the callee's port. Ports 3478-3497 are STUN/TURN ports commonly used in VoIP — a reasonable initial guess. Once the real port arrives, targeted spray takes over.

### How ADF is defeated

**Without spray (fails):**
1. Caller queries STUN → gets srflx with external port P
2. NAT mapping for port P was created for destination = STUN server
3. Callee sends ICE check to caller's srflx (port P), from callee's IP
4. Caller's ADF NAT checks: "has the device sent to this source IP before?" → No
5. Packet dropped. ICE fails.

**With spray (works):**
1. Caller sprays to calleeIp (20 ports blind, then 41 ports targeted)
2. Each spray candidate causes ICE to send STUN Binding Request to calleeIp
3. Caller's NAT creates mapping: "allow packets from calleeIp"
4. Callee sprays to callerIp (41 ports ±20 of caller's srflx port)
5. Callee's packets from calleeIp arrive at caller → ADF allows them
6. ICE connects via peer-reflexive candidate discovery

**RFC 4787 NAT behavior types and spray coverage:**

| NAT Filtering Type | Behavior | Spray needed? |
|---|---|---|
| Endpoint-Independent (EIF) | Accepts from any source | No — works without spray |
| Address-Dependent (ADF) | Accepts from IPs the device sent to | Yes — spray opens for peer's IP |
| Address+Port-Dependent (APDF) | Accepts from exact IP:port sent to | Spray covers ±20 port range |

### CGNAT (Carrier-Grade NAT) — Mobile Data

Mobile carriers place phones behind CGNAT, which typically implements **symmetric NAT** (Port-Dependent Mapping). The external port depends on both source and destination — a STUN query returns port P, but sending to a different destination gets a completely different port.

Confirmed during testing: phone's STUN external port was 59805, but the port seen by the Mac was 61479.

**Broadband-as-caller, phone-as-callee (works):**

1. Mac (broadband, EIM) has stable srflx port regardless of destination
2. Mac broadcasts CALL TX with srflx candidates
3. Blind spray: Mac sprays to phone's known IP (VoIP range)
4. Phone receives CALL TX, discovers own port via STUN, broadcasts PORT token
5. Mac receives PORT token, switches to targeted ±20 spray
6. Phone sprays ±20 around Mac's srflx port
7. ICE checks cross → connection established

**Phone-as-caller (fails — symmetric NAT):**

1. Phone queries STUN → gets srflx port P (mapped for STUN server only)
2. Callee sends ICE checks to port P → CGNAT drops them (mapping is for STUN server IP only)
3. Spray cannot help: CGNAT assigns different ports per destination (Port-Dependent Mapping), so the srflx port itself is wrong for the callee's IP

**Phone-to-phone (both on CGNAT — fails):**

Both sides have symmetric NAT. Neither side's srflx port is valid for the other. Only a TURN relay could bridge two symmetric NATs.

### Compatibility matrix

```
Caller              Callee              Result
──────────────────  ──────────────────  ──────────────────────────
Broadband (EIF)     Phone (CGNAT)       Works (1-TX, no spray needed)
Broadband (ADF)     Phone (CGNAT)       Works with spray (2-TX)
Broadband (ADF)     Broadband (EIF)     Works with spray (2-TX)
Broadband (ADF)     Broadband (ADF)     Works with mutual spray (2-TX)
Broadband (EIF)     Broadband (EIF)     Works (1-TX, no spray needed)
Phone (CGNAT)       Broadband           Fails (symmetric NAT, srflx invalid)
Phone (CGNAT)       Phone (CGNAT)       Fails (both symmetric)
LAN                 LAN                 Works (host candidates)
```

**v09.01 improvement over v09.00:** All `Broadband → *` rows now work without UPnP or any local server. The spray mechanism is pure browser code.

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
[2+N]     SDP (2-byte length + UTF-8, empty for CXID and PORT)
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

**PORT token:** Uses ANS prefix. SDP field is empty. `senderIp4` carries the callee's discovered public IP, `port` carries the discovered public port. The caller recognizes it as a port-only announcement when `sdpAnswer` is empty/null.

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
    call_manager.js      -- Call lifecycle: 1-TX, 2-TX port discovery, spray
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
- **IP in contacts**: The public IP in the contact string is used only for port spraying. It is shared out-of-band (same as the fingerprint). A stale or incorrect IP causes the spray to target the wrong host — the call may fail on ADF NATs but no security property is compromised. The IP is already publicly visible in the on-chain CALL TX (senderIp field).
- **PORT token**: Reveals the callee's public port on-chain. This is equivalent information to what any peer on the internet discovers during ICE connectivity checks. No additional attack surface is created.

## Limitations

- **NAT compatibility**: The 1-TX flow requires the caller's NAT to have Endpoint-Independent Mapping (EIM) so the srflx port is valid for any destination. ADF filtering is handled by port spray if the callee's IP is in contacts. Mobile CGNAT (symmetric NAT) cannot be the caller — the srflx port is only valid for the STUN server. A TURN relay would be needed for phone-as-caller or phone-to-phone calls.
- **Stale IP**: If the callee's public IP changes after contact exchange, port spray targets the wrong host. The call fails on ADF NATs. Users need to re-share identity strings. Broadband IPs are typically stable.
- **Single device per address**: The persistent DTLS certificate ties a fingerprint to one device. Calling the same address from a different device requires a new identity exchange.
- **Contact exchange required**: The 1-TX path only works after fingerprints have been exchanged. First-time callers must complete the CXID identity exchange (2 transactions) before making a real call.
- **PORT token latency**: The callee must discover its port via STUN and broadcast a PORT token before the caller can do targeted spraying. This adds ~2-5 seconds. The blind spray (VoIP range) provides partial coverage during this window.
