# Token Optimization Plan — Step by Step

Each step is independent. Test a full ADSL<->Cable call between each step before proceeding.

---

## Step 1. Remove senderIp4 + senderIp6 duplicates from tokenAttributes — DONE (v09_03)

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

## Step 2. Remove media types field from tokenAttributes — DONE (v09_03)

**Savings:** 1 byte per token
**Risk:** Low — always 0x01 (audio), never checked

**Files:**
- `call_token.js` — `encodeCallAttributes()`: stop writing mediaTypes byte
- `call_token.js` — `decodeCallAttributes()`: stop reading mediaTypes byte

**Test:** Call connects normally.

---

## Step 3. Remove unused tokenRules fields (Restrictions + Version) — DONE (v09_03)

**Savings:** 4 bytes per token
**Risk:** Low — only Supply and Divisibility are read (by wallet UI)

tokenRules goes from 8 bytes to 4 bytes.

**Files:**
- `call_token.js` — `encodeSignalRules()`: only write Supply (2 bytes) + Divisibility (2 bytes)
- `wallet-ui.js` — `decodeTokenRules()`: handle both 4-byte and 8-byte rules (backward compat)

**Test:** Call connects. Wallet displays Supply=1 correctly.

---

## Step 4. Binary sessionKey (raw 32 bytes instead of base64 44 bytes) — DONE (v09_03)

**Savings:** 12 bytes per token
**Risk:** Low — encode/decode both sides updated together

Currently sessionKey is stored as base64 string (44 chars). Send the raw 32 bytes instead and base64-encode on decode.

**Files:**
- `call_token.js` — `encodeCallAttributes()`: write raw bytes instead of base64 string
- `call_token.js` — `decodeCallAttributes()`: read raw bytes, convert to base64
- Bump tokenAttributes version byte (0x02 → 0x03)

**Test:** Call connects. ICE credentials derived correctly (ufrag/pwd match).

---

## Step 5. Strip ICE candidates from SDP before encoding — DEFERRED

**Savings:** ~450 bytes pre-compression (~120 bytes post-gzip)
**Risk:** HIGH — caused reliability issues in three separate attempts

**Problem:** Stripping candidates (even just srflx/relay, keeping host) consistently
degraded call success rate. First call after refresh works, subsequent calls fail.
Root cause unclear — the callee already strips candidates locally before
setRemoteDescription, so removing them from the TX should be safe in theory.
Possible causes: NAT flood protection triggered by spray patterns after candidate
removal changes ICE timing, or subtle interaction with `_buildPublicIpCandidates()`
which reads host candidate ports from the SDP.

**Attempts:**
1. Strip all `a=candidate:` lines — failed (callee couldn't build srflx candidates)
2. Strip all + `a=end-of-candidates` — same failure
3. Strip only srflx/relay, keep host — still degraded reliability

**Decision:** Not worth the risk. Post-gzip savings are only ~120 bytes.

---

## Step 6. Eliminate CXID — fingerprint exchange on first call — DONE (v09_03)

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

## Step 7. Compress SDP with gzip — DONE (v09_04)

**Savings:** ~4,500 bytes per token (73-75% compression measured in production)
**Risk:** Low — browser CompressionStream API, deterministic encode/decode

**Files:**
- `call_token.js` — `encodeStateData()`: compress SDP bytes with gzip before hex encoding
- `call_token.js` — `decodeStateData()`: decompress gzip before UTF-8 decode
- Gzip magic bytes (0x1f 0x8b) used for backward compat detection vs raw UTF-8

**Measured results:**
- CALL SDP: ~7,900 chars → ~1,970 bytes (75% saved)
- ANS SDP: ~5,770 chars → ~1,560 bytes (73% saved)

**Test:** Call connects. SDP round-trip self-test passes. TX size drops from ~7KB to ~2.3KB.

---

## Step 8. Strip redundant SDP lines before compression — DEFERRED

**Savings:** ~200 bytes post-gzip (750 bytes pre-compression, but gzip already handles repetition well)
**Risk:** Medium — must rebuild stripped lines on decode; browser differences may break codec negotiation

Strip boilerplate SDP lines that can be reconstructed:
- `a=extmap:` lines (~500 bytes)
- `a=rtcp-fb:` lines (~200 bytes)
- `a=fmtp:` for standard codecs (~100 bytes)

**Problem:** These lines vary between browser versions and platforms. Rebuilding them
with hardcoded defaults risks mismatches that silently break codec negotiation or
RTP header extensions. Since gzip already compresses repetitive boilerplate efficiently,
the post-compression savings (~200 bytes) don't justify the risk.

---

## Step 9 (future). Shorten addresses to pubkey hash — NOT STARTED

**Savings:** 28 bytes per token
**Risk:** Medium — decoder must reconstruct full address from hash + network byte

Not urgent. Revisit after other improvements are stable.

---

## Running totals (actual)

| Step | Status | tokenAttributes | stateData | TX total | Saved |
|------|--------|----------------|-----------|----------|-------|
| Baseline | — | ~236 B | ~6,500 B | ~7,055 B | — |
| Steps 1-3 | DONE | ~225 B | ~6,500 B | ~7,044 B | 11 B |
| Step 4 | DONE | ~213 B | ~6,500 B | ~7,032 B | 23 B |
| Step 5 | DEFERRED | — | — | — | — |
| Step 6 | DONE | — | — | — | no CXID TX (~7KB saved per new contact) |
| Step 7 | DONE | ~213 B | ~1,750 B | ~2,280 B | **~4,775 B (68%)** |
| Steps 8-9 | DEFERRED | — | — | — | — |

**Current production TX size: ~2,280 bytes (down from ~7,055 — 68% reduction)**
