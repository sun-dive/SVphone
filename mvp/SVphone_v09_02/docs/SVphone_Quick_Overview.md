# SVphone Quick Overview

Peer-to-peer encrypted voice/video calls using BSV blockchain for signaling. No TURN servers, no central infrastructure.

## Core Concepts

- **Identity** = BSV address + persistent DTLS fingerprint (stored in IndexedDB)
- **Signaling** = BSV transactions (caller and callee broadcast tokens to blockchain)
- **Connection** = Direct WebRTC with derived ICE credentials + NAT hole-punching
- **Contact format**: `ADDRESS:sha-256:AB:CD:EF:...@IP` (IP optional)

---

## Step 1: Identity Exchange (First Contact Only)

Two users must swap DTLS fingerprints before they can call each other.

```
  Alice                      BSV Blockchain                     Bob
    |                              |                              |
    |-- CXID TX ------------------>|                              |
    |   [Alice fingerprint]        |                              |
    |                              |<--- polls every 2s --------->|
    |                              |         Bob detects CXID     |
    |                              |         Bob accepts          |
    |                              |         Saves Alice contact  |
    |                              |                              |
    |                              |<---------- ANS TX -----------|
    |                              |       [Bob fingerprint]      |
    |<--- polls every 2s -------->|                               |
    |    Alice detects ANS         |                              |
    |    Saves Bob contact         |                              |
    |                              |                              |
    v                              v                              v
  Both now have each other's fingerprint in ContactsStore
```

---

## Step 2: Peer-to-Peer Call (2-TX Flow)

```
  Caller                     BSV Blockchain                   Callee
    |                              |                              |
    | 1. Create PeerConnection     |                              |
    | 2. Derive ICE creds          |                              |
    |    from session key          |                              |
    | 3. Create munged offer       |                              |
    | 4. STUN gather (srflx port)  |                              |
    | 5. Build synthetic answer    |                              |
    |    (using callee fingerprint)|                              |
    | 6. setRemoteDescription      |                              |
    |                              |                              |
    |-- CALL TX ------------------>|                              |
    |   [offer SDP, fingerprint,   |                              |
    |    sessionKey, IP:port]      |                              |
    |                              |<--- polls ------ detects --->|
    |                              |                              |
    |                              |   7. Derive same ICE creds   |
    |                              |   8. Create munged answer    |
    |                              |   9. STUN gather (srflx port)|
    |                              |                              |
    |                              |<---------- ANS TX -----------|
    |                              |   [answer SDP, fingerprint,  |
    |<--- polls ------ detects --->|    IP:port]                  |
    |                              |                              |
    |========== UDP Hole-Punch Spray (both sides) ================|
    |                              |                              |
    | Spray to callee IP:port +-5  |    Spray to caller IP:port +-5
    |          with alternating    |    with alternating          |
    |          delay pattern       |    delay pattern             |
    |                              |                              |
    |<============= ICE Connected (peer-reflexive) =============>|
    |<============= DTLS Handshake ===========================>  |
    |<============= SRTP Media (audio/video) =================>  |
```

---

## Key Mechanisms

### Derived ICE Credentials
Both sides compute identical ICE ufrag/pwd from the session key using HMAC-SHA256. No extra round-trip needed for ICE negotiation.

### Synthetic Answer
Caller builds the callee's SDP answer locally using the callee's stored fingerprint and derived ICE credentials. The caller's WebRTC stack is ready to receive before any response arrives.

### NAT Hole-Punch Spray
After both TXs are in mempool, both sides inject ICE candidates targeting the peer's STUN-discovered port +/- 5 ports. An alternating delay pattern ensures both "caller first" and "callee first" orderings are tried, covering different firewall behaviors.

### Persistent DTLS Certificate
Each device generates one ECDSA P-256 certificate stored in IndexedDB. The SHA-256 fingerprint serves as the device's call identity, shared once during identity exchange.

---

## NAT Compatibility

| Caller NAT | Callee NAT | Result |
|------------|------------|--------|
| Consumer (Full Cone) | Consumer (Full Cone) | Works |
| Consumer | Mobile (CGNAT) | Works |
| Mobile (CGNAT) | Consumer | Works |
| Mobile (CGNAT) | Mobile (CGNAT) | Works |
| Consumer | Business (Symmetric/ADF) | Works (caller direction) |
| Business (Symmetric/ADF) | Consumer | Fails (callee can't receive) |

Business-grade routers with symmetric NAT or address-dependent filtering (e.g., TP-Link ER605) may only work as the caller, not the callee.

---

## File Structure

```
src/
  dtls_cert_store.js      Persistent RTCCertificate (IndexedDB)
  contacts_store.js       Contact fingerprint + IP storage (localStorage)
  ice_credentials.js      HMAC-SHA256 ICE credential derivation
  synthetic_sdp.js        Caller-side answer SDP builder
  sv_connect/
    call_manager.js       Call lifecycle + spray orchestration
    peer_connection.js    WebRTC connection management
    signaling.js          Blockchain token polling + broadcast
    call_token.js         Binary token encoding/decoding
```
