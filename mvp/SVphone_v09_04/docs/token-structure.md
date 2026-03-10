# SVphone v09.03 Token Structure & Size Analysis

## Transaction Structure

Each signal token (CALL, ANS, CXID) is a single Bitcoin SV transaction:

```
Output 0: OP_RETURN (0 sats)  -- P v03 protocol data
Output 1: P2PKH (1 sat)       -- to recipient (for address indexing)
Output 2: P2PKH (change)      -- back to sender
```

---

## OP_RETURN Fields (P Protocol v03)

Each field is a separate pushdata chunk in the OP_RETURN script.

### Field 0: P Prefix
| | |
|---|---|
| Content | `"P"` (0x50) |
| Data | 1 byte |
| Pushdata opcode | 1 byte |
| **Script total** | **2 bytes** |

### Field 1: Version
| | |
|---|---|
| Content | 0x03 (P v03) |
| Data | 1 byte |
| Pushdata opcode | 1 byte |
| **Script total** | **2 bytes** |

### Field 2: tokenName
| Token | Name | Data bytes | Pushdata | Script total |
|-------|------|-----------|----------|-------------|
| CALL  | `CALL-v1` | 7 | 1 | **8** |
| ANS   | `ANS-v1`  | 6 | 1 | **7** |
| CXID  | `CXID-v1` | 7 | 1 | **8** |

### Field 3: tokenScript
| | |
|---|---|
| Content | Empty (signal tokens don't use scripts) |
| Data | 0 bytes |
| Pushdata | OP_PUSHDATA1 (1) + length byte (1) = 2 bytes |
| **Script total** | **2 bytes** |

### Field 4: tokenRules (8 bytes)

4 x uint16 little-endian:

| Bytes | Field | Value |
|-------|-------|-------|
| 0-1 | Supply | 1 (0x0100 LE) |
| 2-3 | Divisibility | 0 (0x0000) |
| 4-5 | Restrictions | Signal + media flags (see below) |
| 6-7 | Version | 1 (0x0100 LE) |

**Restrictions bitfield:**
| Bit | Flag | Hex |
|-----|------|-----|
| 0 | CALL | 0x0001 |
| 1 | ANS  | 0x0002 |
| 2 | CXID | 0x0004 |
| 3 | Audio | 0x0008 |
| 4 | Video | 0x0010 |

**Per token type (audio only):**
| Token | Restrictions | Full tokenRules hex |
|-------|-------------|-------------------|
| CALL  | 0x0009 | `0100000009000100` |
| ANS   | 0x000A | `01000000 0A000100` |
| CXID  | 0x000C | `0100000 0C000100` |

| | |
|---|---|
| Data | 8 bytes |
| Pushdata opcode | 1 byte |
| **Script total** | **9 bytes** |

---

### Field 5: tokenAttributes (binary metadata)

Encoded by `encodeCallAttributes()`. No SDP -- that's in stateData.

| Offset | Field | Encoding | Bytes |
|--------|-------|----------|-------|
| 0 | Version | uint8 = 0x02 | 1 |
| 1 | IP type | uint8: 0x00=IPv4, 0x01=IPv6 | 1 |
| 2 | IP address | 4 bytes (IPv4) or 16 bytes (IPv6) | 4 |
| 6 | Port | uint16 big-endian | 2 |
| 8 | SessionKey len | uint8 | 1 |
| 9 | SessionKey | UTF-8 (base64 of 32 random bytes) | 44 |
| 53 | Codec | uint8 enum (0=opus) | 1 |
| 54 | Quality | uint8 enum (1=hd) | 1 |
| 55 | Media types | uint8 bitmask (0x01=audio) | 1 |
| 56 | Caller addr len | uint8 | 1 |
| 57 | Caller address | UTF-8 BSV address | 34 |
| 91 | Callee addr len | uint8 | 1 |
| 92 | Callee address | UTF-8 BSV address | 34 |
| 126 | senderIp4 len | uint8 (4=present, 0=absent) | 1 |
| 127 | senderIp4 | 4 bytes IPv4 (if present) | 4 |
| 131 | senderIp6 len | uint8 (16=present, 0=absent) | 1 |
| 132 | senderIp6 | 0 bytes (typically absent) | 0 |
| 132 | Fingerprint len | uint8 | 1 |
| 133 | Fingerprint | UTF-8 `"sha-256 XX:XX:...:XX"` | 103 |

**Typical tokenAttributes total: ~236 bytes**

| | |
|---|---|
| Data | ~236 bytes |
| Pushdata | OP_PUSHDATA1 (1) + length (1) = 2 bytes |
| **Script total** | **~238 bytes** |

**Breakdown by purpose:**

| Category | Fields | Bytes | % of attrs |
|----------|--------|-------|-----------|
| Protocol | version | 1 | 0.4% |
| Network | IP type + IP + port + Ip4 + Ip6 | 13 | 5.5% |
| ICE | sessionKey (len + data) | 45 | 19.1% |
| Media | codec + quality + mediaTypes | 3 | 1.3% |
| Routing | caller addr + callee addr (lens + data) | 70 | 29.7% |
| Identity | fingerprint (len + data) | 104 | 44.1% |

---

### Field 6: stateData (SDP)

Encoded by `encodeStateData()`: UTF-8 SDP string converted to hex, then `hexToBytes()` in opReturnCodec gives raw bytes.

| Token | Typical SDP chars | Raw bytes | Pushdata overhead | Script total |
|-------|-------------------|-----------|-------------------|-------------|
| CALL (offer) | ~6,563 | ~6,563 | 3 (OP_PUSHDATA2 + 2-byte len) | **~6,566** |
| ANS (answer) | ~5,900 | ~5,900 | 3 | **~5,903** |
| CXID (offer) | ~6,500 | ~6,500 | 3 | **~6,503** |
| CXID-ANS (empty) | 0 | 1 (0x00) | 2 (OP_PUSHDATA1 + len) | **3** |

---

## Total OP_RETURN Script Size

| Component | CALL | ANS | CXID |
|-----------|------|-----|------|
| OP_0 + OP_RETURN | 2 | 2 | 2 |
| P prefix | 2 | 2 | 2 |
| Version | 2 | 2 | 2 |
| tokenName | 8 | 7 | 8 |
| tokenScript | 2 | 2 | 2 |
| tokenRules | 9 | 9 | 9 |
| tokenAttributes | ~238 | ~238 | ~238 |
| stateData (SDP) | **~6,566** | **~5,903** | **~6,503** |
| **Total script** | **~6,829** | **~6,165** | **~6,766** |

---

## Full Transaction Size

| Component | Bytes |
|-----------|-------|
| TX overhead (version + locktime) | 10 |
| Input (1 P2PKH) | ~148 |
| Output 0: OP_RETURN | ~6,165 - 6,829 |
| Output 1: P2PKH 1-sat | 34 |
| Output 2: P2PKH change | 34 |
| **CALL TX total** | **~7,055** |
| **ANS TX total** | **~6,391** |

---

## Where the Bytes Go

```
CALL Token (~7,055 bytes)
=========================

  SDP offer (stateData)    6,566 bytes   93.1%  ████████████████████████████████████████
  tokenAttributes            238 bytes    3.4%  █
  TX structure               226 bytes    3.2%  █
  Protocol overhead           25 bytes    0.4%
                           ─────
                           7,055 bytes

ANS Token (~6,391 bytes)
========================

  SDP answer (stateData)   5,903 bytes   92.4%  ████████████████████████████████████████
  tokenAttributes            238 bytes    3.7%  █
  TX structure               226 bytes    3.5%  █
  Protocol overhead           24 bytes    0.4%
                           ─────
                           6,391 bytes
```

**The SDP is 92-93% of the total transaction size.**

---

## Cost per Token

At fee rate 100 sats/KB (typical for signal tokens):

| Token | TX size | Fee | + 1 sat output | Total cost |
|-------|---------|-----|----------------|-----------|
| CALL  | ~7,055 B | ~706 sats | 1 sat | **~707 sats** |
| ANS   | ~6,391 B | ~640 sats | 1 sat | **~641 sats** |
| CXID  | ~7,000 B | ~700 sats | 1 sat | **~701 sats** |

At 1 BSV = $50 USD:
- 1 sat = $0.0000005
- CALL token cost: ~$0.00035 USD
- Full call (CALL + ANS): ~$0.00067 USD

---

## Optimization Opportunities

| Opportunity | Current | Potential | Savings |
|-------------|---------|-----------|---------|
| Eliminate CXID token | ~7,000 bytes per new contact | 0 (fingerprint rides on CALL/ANS) | **~7,000 per new contact** |
| SDP compression (gzip/brotli) | ~6,500 raw | ~2,000 compressed | **~65% of TX** |
| Remove SDP candidates from stateData | 3 candidates in SDP | Strip before encoding | ~300 bytes |
| Strip redundant SDP lines | ~1,000 bytes boilerplate | Reconstruct on decode | ~750 bytes |
| Shorter addresses (use hash instead of full) | 34+34 = 68 bytes | 20+20 = 40 bytes | 28 bytes |
| Binary sessionKey (not base64) | 44 bytes | 32 bytes | 12 bytes |
| Remove senderIp4/Ip6 duplicates | 5+1 = 6 bytes | 0 (use main IP field) | 6 bytes |
| Remove unused tokenRules fields | 8 bytes | 4 bytes (keep Supply + Divisibility) | 4 bytes |
| Remove media types field | 1 byte | 0 (always audio) | 1 byte |
