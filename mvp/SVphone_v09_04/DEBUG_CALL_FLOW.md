# 1-TX Call Flow — Caller vs Callee (v09.02)

## Side-by-Side Sequence

| Step | Caller | Callee |
|------|--------|--------|
| **1** | `initiateCall()` L98: Get callee fingerprint + IP from contacts | *(waiting)* |
| **2** | L159: Initialize media stream (audio/video) | *(waiting)* |
| **3** | L169: Derive ICE creds from random session key | *(waiting)* |
| **4** | L191: Create DataChannel `sv-punch` on PC | *(waiting)* |
| **5** | L194: `createOfferMunged()` — set local desc with derived ICE creds | *(waiting)* |
| **6** | L195: `waitForIceGathering()` — STUN srflx lands in offer SDP | *(waiting)* |
| **7** | L215: Build synthetic answer (callee fingerprint + callee ICE creds) | *(waiting)* |
| **8** | L221: `setRemoteDescription(syntheticAnswer)` — ICE starts listening | *(waiting)* |
| **9** | L230: **Broadcast CALL TX** (offer SDP + fingerprint + srflx port) | *(waiting)* |
| **10** | L234: `_startNatKeepalive()` — dummy candidates every 15s | *(waiting)* |
| **11** | *(waiting for PORT token)* | `onIncomingCall()` L282: Detects CALL TX in mempool |
| **12** | *(waiting for PORT token)* | L305: Calls `_startPrePunch()` **immediately** (before user clicks Accept) |
| **13** | *(waiting for PORT token)* | L867: Derive ICE creds from caller's session key |
| **14** | *(waiting for PORT token)* | **L878: Strip ICE candidates from offer SDP** (new in v09_02) |
| **15** | *(waiting for PORT token)* | L882: `createAnswerMunged(strippedOffer)` — set remote desc + local desc |
| **16** | *(waiting for PORT token)* | L885: `waitForIceGathering()` — STUN srflx lands in answer SDP |
| **17** | *(waiting for PORT token)* | L893: `announceSrflx()` — extract callee's srflx IP:port |
| **18** | *(waiting for PORT token)* | L899: `_startNatKeepalive()` — keep binding alive |
| **19** | *(waiting for PORT token)* | L900: Emit `call:port-discovered` |
| **20** | *(waiting for PORT token)* | phone-controller L500: **Broadcast PORT TX** (callee srflx IP:port) |
| **21** | *(waiting for PORT token)* | phone-controller L515: `startCalleeSpray()` |
| **22** | *(waiting for PORT token)* | L1009: Stop NAT keepalive |
| **23** | *(waiting for PORT token)* | L1012: **Start spray** to caller IP:port ±20 (every 3s, up to 2 min) |
| **24** | `onCallAnswered()` L618: Receives PORT token from mempool | *(spraying)* |
| **25** | L622: Stop NAT keepalive | *(spraying)* |
| **26** | L626: **Start spray** to callee IP:port ±20 (every 3s, up to 2 min) | *(spraying)* |
| **27** | *(spraying — both sides now)* | *(spraying — both sides now)* |
| **28** | ICE peer-reflexive candidate found → DTLS → **connected** | ICE peer-reflexive candidate found → DTLS → **connected** |
| | | |
| **User Accept** | *(already spraying/connected)* | User clicks Accept → `acceptCall()` L390 |
| | | L391: PC exists + not failed → **reuse pre-punch PC** |
| | | L397: Initialize media stream, add tracks to existing PC |
| | | L413: If already connected → emit `call:connected` |

## Key Asymmetry (Bug Source)

If the callee's pre-punch PC is in `failed` state when user clicks Accept, `acceptCall()` falls through to the **standard flow** (L431) which:

- **L458:** Calls `createAnswerMunged()` with the **full offer SDP** (with candidates) — undoing the stripping
- **L466:** Calls `_buildPublicIpCandidates()` — injects caller IP immediately
- **L484:** Starts spray immediately (no PORT TX synchronization)

This fallback path doesn't have the protections added to `_startPrePunch`.

## NAT Types Under Test

- **Cable (Mac Mini, 210.66.50.184):** EIM (Endpoint-Independent Mapping) — same external port regardless of destination
- **ADSL (MacBook, 114.39.223.197):** Symmetric / EDM (Endpoint-Dependent Mapping) — different external port per destination

## Known Issues (as of v09.02)

1. **ADSL→Cable works** (v09_01 reference): Callee (Cable/EIM) has predictable port, spray hits it
2. **Cable→ADSL fails** (v09_01 reference): Callee (ADSL/EDM) has unpredictable port, spray misses
3. **SDP stripping regression** (fixed in v09_02): Original regex left empty lines in SDP, causing Chrome parse error
4. **Fallback path unprotected**: Standard `acceptCall()` flow at L431+ doesn't strip candidates or synchronize spray
