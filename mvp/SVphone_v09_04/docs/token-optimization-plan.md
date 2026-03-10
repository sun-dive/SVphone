# Token Optimization Plan — Step by Step

Each step is independent. Test a full ADSL<->Cable call between each step before proceeding.

---

## Step 1. Remove senderIp4 + senderIp6 duplicates from tokenAttributes

**Savings:** 6 bytes per token
**Risk:** Low — these fields are never read by the callee

senderIp4 always duplicates the main IP field (bytes 2-5). senderIp6 is never populated (always length 0).

**Files:**
- `call_token.js` — `encodeCallAttributes()`: stop writing senderIp4/senderIp6
- `call_token.js` — `decodeCallAttributes()`: stop reading senderIp4/senderIp6
- `phone-controller.js` — remove references to `attrs.senderIp4` / `attrs.senderIp6`
- `signaling.js` — remove senderIp4/senderIp6 from signal object

**Test:** Call connects, IP logged correctly from main IP field.

---

## Step 2. Remove media types field from tokenAttributes

**Savings:** 1 byte per token
**Risk:** Low — always 0x01 (audio), never checked

**Files:**
- `call_token.js` — `encodeCallAttributes()`: stop writing mediaTypes byte
- `call_token.js` — `decodeCallAttributes()`: stop reading mediaTypes byte

**Test:** Call connects normally.

---

## Step 3. Remove unused tokenRules fields (Restrictions + Version)

**Savings:** 4 bytes per token
**Risk:** Low — only Supply and Divisibility are read (by wallet UI)

tokenRules goes from 8 bytes to 4 bytes.

**Files:**
- `call_token.js` — `encodeSignalRules()`: only write Supply (2 bytes) + Divisibility (2 bytes)
- `wallet-ui.js` — `decodeTokenRules()`: handle both 4-byte and 8-byte rules (backward compat)

**Test:** Call connects. Wallet displays Supply=1 correctly.

---

## Step 4. Binary sessionKey (raw 32 bytes instead of base64 44 bytes)

**Savings:** 12 bytes per token
**Risk:** Low — encode/decode both sides updated together

Currently sessionKey is stored as base64 string (44 chars). Send the raw 32 bytes instead and base64-encode on decode.

**Files:**
- `call_token.js` — `encodeCallAttributes()`: write raw bytes instead of base64 string
- `call_token.js` — `decodeCallAttributes()`: read raw bytes, convert to base64
- Bump tokenAttributes version byte (0x02 → 0x03)

**Test:** Call connects. ICE credentials derived correctly (ufrag/pwd match).

---

## Step 5. Strip ICE candidates from SDP before encoding

**Savings:** ~450 bytes per token
**Risk:** Low — callee already strips candidates on decode; IP:port is in tokenAttributes

**Files:**
- `call_token.js` — `encodeStateData()`: strip `a=candidate:` lines before hex encoding
- No decode changes needed (callee already ignores candidates)

**Test:** Call connects. Candidates are injected from tokenAttributes IP:port as before.

---

## Step 6. Eliminate CXID — fingerprint exchange on first call

**Savings:** ~7,000 bytes per new contact (entire CXID TX eliminated)
**Risk:** Medium — changes call flow for unknown callers

Every CALL/ANS token already carries the sender's fingerprint. Remove the separate CXID exchange flow. First call to a new contact doubles as identity exchange.

Callee behavior on incoming CALL:
- **Known fingerprint** → accept, proceed normally
- **Unknown fingerprint** → prompt "Unknown caller: [address]", accept stores fingerprint
- **Changed fingerprint** → prompt "Caller changed device", accept updates stored fingerprint

**Files:**
- `call_manager.js` — remove CXID broadcast/detect paths, add unknown-caller handling
- `call_token.js` — remove CXID case from `encodeSignalRules()`
- `phone-controller.js` — remove CXID signal handling
- `phone-handlers.js` — remove identity exchange UI logic
- `signaling.js` — remove CXID polling

**Test:** First call to new contact works without prior CXID exchange. Fingerprints stored after call.

---

## Step 7. Compress SDP with gzip

**Savings:** ~4,500 bytes per token (64% of TX)
**Risk:** Low — browser CompressionStream API, deterministic encode/decode

**Files:**
- `call_token.js` — `encodeStateData()`: compress SDP bytes with gzip before hex encoding
- `call_token.js` — `decodeStateData()`: decompress gzip before UTF-8 decode
- Add version/magic byte prefix to distinguish compressed vs raw stateData

**Test:** Call connects. SDP round-trip self-test passes. TX size drops from ~7KB to ~2.5KB.

---

## Step 8. Strip redundant SDP lines before compression

**Savings:** ~750 bytes per token (before compression), improves compression ratio further
**Risk:** Medium — must rebuild stripped lines on decode

Strip boilerplate SDP lines that can be reconstructed:
- `a=extmap:` lines (~500 bytes)
- `a=rtcp-fb:` lines (~200 bytes)
- `a=fmtp:` for standard codecs (~100 bytes)

**Files:**
- `call_token.js` — `encodeStateData()`: strip known boilerplate lines
- `call_token.js` — `decodeStateData()`: rebuild stripped lines from defaults

**Test:** Call connects. Media negotiation works (codec, RTP extensions correct).

---

## Step 9 (future). Shorten addresses to pubkey hash

**Savings:** 28 bytes per token
**Risk:** Medium — decoder must reconstruct full address from hash + network byte

Not urgent. Revisit after steps 1-8 are stable.

---

## Running totals

| After step | tokenAttributes | stateData | TX total | Cumulative saved |
|------------|----------------|-----------|----------|-----------------|
| Current | ~236 B | ~6,500 B | ~7,055 B | — |
| Step 1 | ~230 B | ~6,500 B | ~7,049 B | 6 B |
| Step 2 | ~229 B | ~6,500 B | ~7,048 B | 7 B |
| Step 3 | ~229 B | ~6,500 B | ~7,044 B | 11 B |
| Step 4 | ~217 B | ~6,500 B | ~7,032 B | 23 B |
| Step 5 | ~217 B | ~6,050 B | ~6,582 B | 473 B |
| Step 6 | ~217 B | ~6,050 B | ~6,582 B | 473 B + no CXID TX |
| Step 7 | ~217 B | ~1,800 B | ~2,332 B | ~4,723 B |
| Step 8 | ~217 B | ~1,500 B | ~2,032 B | ~5,023 B |
