import { randomBytes } from "crypto"

// In-tree ULID generator — Phase 1 of the architectural rescue.
//
// The ledger demands monotonically-sortable ids so chronological queries
// can use ID ranges and the audit trail reads coherently. ULIDs give us
// that (10-char Crockford-base32 timestamp + 16-char randomness, total
// 26 chars). The full `ulid` npm package is overkill for the few hundred
// lines of generation logic we need, and adding a dep means another
// `pnpm install --prod` step on clawd-server. So we inline.
//
// This is not a cryptographic primitive — its job is to be a unique,
// time-sortable identifier. Random bytes come from `crypto.randomBytes`
// purely because it's the right tool for "give me bytes" and there's no
// reason to use weaker randomness.

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" // Crockford base32

const TIME_LEN = 10
const RAND_LEN = 16

function encodeTime(ms: number): string {
  let out = ""
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING[ms & 31] + out
    ms = Math.floor(ms / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = randomBytes(RAND_LEN)
  let out = ""
  for (let i = 0; i < RAND_LEN; i++) {
    out += ENCODING[bytes[i] & 31]
  }
  return out
}

/** Generate a new ULID. Pass `now` for deterministic tests. */
export function newEventId(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/** Extract the timestamp portion from a ULID. Inverse of `newEventId`'s
 *  time prefix. Useful for sanity checks; not load-bearing. */
export function decodeTime(id: string): number {
  let ms = 0
  for (let i = 0; i < TIME_LEN; i++) {
    const v = ENCODING.indexOf(id[i])
    if (v < 0) throw new Error(`invalid ULID character at position ${i}: ${id[i]}`)
    ms = ms * 32 + v
  }
  return ms
}
