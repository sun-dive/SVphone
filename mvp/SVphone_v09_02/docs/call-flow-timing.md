# SVphone v09.02 — Call Flow Timing Chart (1-TX Mode)

Side-by-side caller vs callee events with data state at each step.

```
Time    CALLER                                    CALLEE
────    ──────                                    ──────

T+0s    ┌─ initiateCall() ─────────────────┐
        │                                  │
        │  Data available:                 │
        │    calleeFingerprint (contacts)  │
        │    myFingerprint (IndexedDB)     │
        │                                  │
        │  1. Generate sessionKey (32B)    │
        │  2. deriveAll(sessionKey)        │
        │     → callerUfrag, callerPwd     │
        │     → calleeUfrag, calleePwd     │
        │  3. initializeMediaStream()      │
        │  4. createPeerConnection()       │
        │     iceServers: google STUN      │
        │  5. createDataChannel('sv-punch')│
        │  6. createOfferMunged()          │
        │     mungeSdp(callerUfrag,        │
        │              callerPwd)          │
        │  7. setLocalDescription(offer)   │
        │                                  │
        └──────────────────────────────────┘

T+1s    ┌─ STUN query ────────────────────┐
        │                                  │
        │  waitForIceGathering()           │
        │  → stun:stun.l.google.com:19302  │
        │  → srflx: MY_IP:CALLER_PORT     │
        │                                  │
        │  Data produced:                  │
        │    finalOffer.sdp (with srflx)   │
        │    senderPort = CALLER_PORT      │
        │                                  │
        └──────────────────────────────────┘

T+2s    ┌─ Synthetic answer ──────────────┐
        │                                  │
        │  syntheticSdp.build(             │
        │    offer,                        │
        │    calleeUfrag, calleePwd,       │
        │    calleeFingerprint             │
        │  )                               │
        │  setRemoteDescription(synth)     │
        │                                  │
        │  ICE state: stable               │
        │  (listening for peer-reflexive)  │
        │                                  │
        └──────────────────────────────────┘

T+3s    ┌─ Broadcast CALL TX ─────────────┐
        │                                  │
        │  createCallSignalTx("CALL-...")  │
        │                                  │
        │  CALL TX carries:                │
        │    caller address                │
        │    callee address                │
        │    senderIp4 (caller public IP)  │
        │    senderPort (CALLER_PORT)      │
        │    sessionKey                    │
        │    sdpOffer (full, with srflx)   │
        │    callerFingerprint             │
        │    codec, quality, mediaTypes    │
        │                                  │
        │  → TX enters mempool             │
        │                                  │
        └──────────────────────────────────┘
        │
        │  ICE state: stable
        │  Caller's NAT binding at
        │  CALLER_PORT is IDLE from
        │  this moment onward.
        │  (created during STUN at T+1s)
        │
        ▼
        ┌──────────────────────────────────┐
        │  WAITING for ANS token...        │
        │  polling getUtxos() every 2s     │
        │                                  │
        │  NAT binding aging...            │
        │  (typically expires 30-120s)     │
        └──────────────────────────────────┘


                    ════════ MEMPOOL PROPAGATION ════════


                                                  T+5-15s ┌─ scanSignalsFn() ─────────────┐
                                                          │                                │
                                                          │  Poll detects new UTXO         │
                                                          │  getSourceTransaction(txId)    │
                                                          │  decodeOpReturn() → CALL token │
                                                          │                                │
                                                          │  Data extracted from CALL TX:  │
                                                          │    caller address              │
                                                          │    senderIp4 (caller IP)       │
                                                          │    senderPort (CALLER_PORT)    │
                                                          │    sessionKey                  │
                                                          │    sdpOffer                    │
                                                          │    callerFingerprint           │
                                                          │                                │
                                                          └────────────────────────────────┘

                                                  T+5-15s ┌─ _startPrePunch() ────────────┐
                                                          │  (runs BEFORE user accepts)    │
                                                          │                                │
                                                          │  1. deriveAll(sessionKey)      │
                                                          │     → same creds as caller     │
                                                          │  2. Strip candidates from offer│
                                                          │  3. createAnswerMunged(        │
                                                          │       callerAddr,              │
                                                          │       strippedOffer,           │
                                                          │       iceCreds,                │
                                                          │       {iceServers: null}       │
                                                          │       → uses google STUN       │
                                                          │     )                          │
                                                          │  4. setRemoteDescription(offer)│
                                                          │  5. createAnswer()             │
                                                          │  6. mungeSdp(calleeUfrag,      │
                                                          │              calleePwd)        │
                                                          │  7. setLocalDescription(answer)│
                                                          │                                │
                                                          └────────────────────────────────┘

                                                  T+6-16s ┌─ STUN query ───────────────────┐
                                                          │                                 │
                                                          │  waitForIceGathering()          │
                                                          │  → stun:stun.l.google.com:19302 │
                                                          │  → srflx: MY_IP:CALLEE_PORT     │
                                                          │                                 │
                                                          │  Data produced:                 │
                                                          │    finalAns.sdp (with srflx)    │
                                                          │    callee IP = MY_IP            │
                                                          │    callee port = CALLEE_PORT    │
                                                          │    sdpAnswer = finalAns.sdp     │
                                                          │    calleeFingerprint            │
                                                          │                                 │
                                                          └─────────────────────────────────┘

                                                  T+7-17s ┌─ emit('call:port-discovered') ─┐
                                                          │                                 │
                                                          │  Data in event:                 │
                                                          │    callTokenId                  │
                                                          │    callerAddress                │
                                                          │    sessionKey                   │
                                                          │    ip = CALLEE_IP               │
                                                          │    port = CALLEE_PORT           │
                                                          │    sdpAnswer = finalAns.sdp     │
                                                          │    calleeFingerprint            │
                                                          │                                 │
                                                          └─────────────────────────────────┘

                                                  T+7-17s ┌─ Broadcast ANS TX ─────────────┐
                                                          │                                 │
                                                          │  broadcastCallAnswer()          │
                                                          │  createCallSignalTx("ANS-...")  │
                                                          │                                 │
                                                          │  ANS TX carries:                │
                                                          │    callee address               │
                                                          │    senderIp4 (CALLEE_IP)        │
                                                          │    senderPort (CALLEE_PORT)     │
                                                          │    sessionKey                   │
                                                          │    sdpAnswer (callee SDP)       │
                                                          │    calleeFingerprint            │
                                                          │    codec, quality, mediaTypes   │
                                                          │                                 │
                                                          │  → TX enters mempool            │
                                                          │                                 │
                                                          └─────────────────────────────────┘

                                                  T+8-22s ┌─ Wait for mempool confirm ─────┐
                                                          │                                 │
                                                          │  getRawTransaction(ansTxId)     │
                                                          │  up to 10 attempts × 2s = 20s   │
                                                          │                                 │
                                                          └─────────────────────────────────┘

                                                  T+10-25s┌─ startCalleeSpray() ───────────┐
                                                          │                                 │
                                                          │  Target: CALLER_IP:CALLER_PORT  │
                                                          │  (from CALL TX senderIp4/Port)  │
                                                          │                                 │
                                                          │  _injectPortSpray():            │
                                                          │    knownPort = CALLER_PORT      │
                                                          │    → single candidate injected  │
                                                          │    → addIceCandidate() on PC    │
                                                          │  Repeat every 10s, up to 120s   │
                                                          │                                 │
                                                          │  ICE: new → checking            │
                                                          │  (first remote candidate added) │
                                                          │                                 │
                                                          └─────────────────────────────────┘


                    ════════ MEMPOOL PROPAGATION ════════


T+12-30s┌─ Detect ANS token ──────────────┐
        │                                  │
        │  scanSignalsFn() finds ANS TX    │
        │  decodeOpReturn() → ANS token    │
        │                                  │
        │  Data extracted from ANS TX:     │
        │    calleeIp4 = CALLEE_IP         │
        │    calleePort = CALLEE_PORT      │
        │    sdpAnswer (not used — synth   │
        │      answer already set)         │
        │    calleeFingerprint             │
        │                                  │
        └──────────────────────────────────┘

T+12-30s┌─ handleCallAnswered() ──────────┐
        │                                  │
        │  Start caller spray:             │
        │  Target: CALLEE_IP:CALLEE_PORT   │
        │  (from ANS TX senderIp4/Port)    │
        │                                  │
        │  _injectPortSpray():             │
        │    knownPort = CALLEE_PORT       │
        │    → single candidate injected   │
        │    → addIceCandidate() on PC     │
        │  Repeat every 10s, up to 120s    │
        │                                  │
        │  ICE: stable → checking          │
        │  (first remote candidate added)  │
        │                                  │
        │  ⚠️  CALLER_PORT NAT binding     │
        │  has been idle since T+1s!       │
        │  Age: 11-29 seconds              │
        │  (may have expired if >30s)      │
        │                                  │
        └──────────────────────────────────┘


        ════════════ SIMULTANEOUS SPRAY ════════════

T+12-30s  CALLER sprays to                 CALLEE sprays to
          CALLEE_IP:CALLEE_PORT            CALLER_IP:CALLER_PORT
          │                                │
          │  Caller's NAT: EIM             │  Callee's NAT: ADF
          │  Sends from CALLER_PORT        │  Sends from CALLEE_PORT
          │  (if binding still alive)      │  (STUN binding was for
          │  or NEW_PORT                   │   Google STUN server,
          │  (if binding expired)          │   NOT for Caller's IP)
          │                                │
          ▼                                ▼

        ┌──────────────────────────────────────────────────────┐
        │                                                      │
        │  ADSL→Cable (WORKS):                                 │
        │    Cable callee STUN at ~T+6s, spray at ~T+10s       │
        │    Cable's CALLER_PORT age when spray hits: ~4-10s   │
        │    → NAT binding still ALIVE → spray gets through    │
        │    → peer-reflexive → DTLS → connected               │
        │                                                      │
        │  Cable→ADSL (FAILS):                                 │
        │    Cable caller STUN at T+1s, callee spray at ~T+25s │
        │    Cable's CALLER_PORT age when spray hits: ~24s+    │
        │    → NAT binding may be EXPIRED                      │
        │    → spray hits dead port → no connection            │
        │                                                      │
        └──────────────────────────────────────────────────────┘
```

## Key Asymmetry

The **caller** gathers STUN early (T+1s) and then sits **idle** until the callee
processes the CALL TX, does its own STUN, broadcasts ANS TX, and that TX propagates
through the mempool back to the caller.

- When **ADSL is caller**: ADSL's NAT binding doesn't matter (ADF/symmetric gives
  a new port per destination anyway). Cable callee's STUN is recent (~4s old).
- When **Cable is caller**: Cable's EIM NAT binding at CALLER_PORT must survive
  the entire wait. If ADSL callee is slow, the gap can be 25-45s — potentially
  exceeding the NAT binding timeout.

## Data Comparison: CALL vs ANS Token

| Field             | CALL TX (caller→callee) | ANS TX (callee→caller) |
|-------------------|-------------------------|------------------------|
| Token prefix      | `CALL-{ident}`          | `ANS-{ident}`          |
| senderIp4         | Caller's public IP      | Callee's public IP     |
| senderPort        | Caller's STUN srflx     | Callee's STUN srflx   |
| sessionKey        | Generated by caller     | Same (echoed back)     |
| sdpOffer/sdpAnswer| Caller's offer SDP      | Callee's answer SDP    |
| fingerprint       | Caller's DTLS cert      | Callee's DTLS cert     |
| codec/quality     | Caller's preference     | Callee's capability    |
| Recipient (1-sat) | Callee address          | Caller address         |
