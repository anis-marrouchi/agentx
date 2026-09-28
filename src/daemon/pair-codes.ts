import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { dirname, resolve } from "path"

// --- One-time pairing codes for the phone app ---
//
// `agentx app pair` mints a device token (for the QR link) AND a short code
// the owner types inside the installed app. iOS gives a home-screen app its
// own storage, so the cookie the QR link set in Safari never reaches it; the
// code is how the installed app gets the same device token.
//
// The code redeems the SAME token as the QR link, so one pairing is one
// device in `agentx app devices`, and revoking it cuts off both.
//
// Nothing usable is stored in the clear. One scrypt run over the code gives
// 64 bytes: the first half, hashed, is the lookup id; the second half is
// the AES-256-GCM key that seals the device token. Without the code, the
// file opens nothing. A code works once (its record is deleted on use) and
// expires after 10 minutes. scrypt runs exactly once per attempt, whatever
// the outcome, so wrong, expired and used codes cost the same time.

/** 31 symbols: digits and capitals without 0/O, 1/I/L. */
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 10 * 60 * 1000
const DEFAULT_FILE = ".agentx/pair-codes.json"
const SCRYPT = { N: 16384, r: 8, p: 1 }

interface PairCodeRecord {
  id: string          // sha256 of the first half of scrypt(code)
  tokenId: string     // the device token it activates (TokenStore id)
  name: string        // device name, returned on success
  sealed: string      // base64(iv | tag | AES-GCM(device token))
  createdAt: string
  expiresAt: string
}

interface PairCodeFile {
  salt: string        // per-folder scrypt salt (hex)
  codes: PairCodeRecord[]
}

/** A random code, e.g. "7KQ4M2XH". Display it with formatCode(). */
export function generateCode(): string {
  let out = ""
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

/** "7KQ4M2XH" → "7KQ4-M2XH". */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Case-insensitive; spaces and dashes (also typographic ones) ignored.
 *  Returns null for anything that can't be a code. */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 64) return null
  const code = input.toUpperCase().replace(/[\s\-‐-―]/g, "")
  if (code.length !== CODE_LENGTH) return null
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null
  return code
}

export class PairCodeStore {
  private file: string

  constructor(baseDir: string = process.cwd(), fileRel: string = DEFAULT_FILE, private now: () => number = Date.now) {
    this.file = resolve(baseDir, fileRel)
  }

  /** Mint a code that redeems `token` (the device token's secret). */
  create(input: { token: string; tokenId: string; name: string }): { code: string; expiresAt: string } {
    const data = this.load()
    const code = generateCode()
    const { id, key } = derive(code, data.salt)
    const now = this.now()
    const expiresAt = new Date(now + CODE_TTL_MS).toISOString()
    data.codes = data.codes.filter((c) => Date.parse(c.expiresAt) > now)
    data.codes.push({
      id,
      tokenId: input.tokenId,
      name: input.name,
      sealed: seal(key, input.token),
      createdAt: new Date(now).toISOString(),
      expiresAt,
    })
    this.save(data)
    return { code, expiresAt }
  }

  /**
   * Trade a code for its device token. Returns null for a malformed, wrong,
   * expired or already used code, with no way to tell those apart. The
   * record is deleted on success, so a second use finds nothing.
   */
  redeem(input: unknown): { token: string; tokenId: string; name: string } | null {
    const data = this.load()
    const code = normalizeCode(input)
    // Derive even for malformed input so every attempt costs one scrypt run.
    const { id, key } = derive(code ?? "-".repeat(CODE_LENGTH), data.salt)
    if (!code) return null
    const idBuf = Buffer.from(id)
    const rec = data.codes.find((c) => c.id.length === id.length && timingSafeEqual(Buffer.from(c.id), idBuf))
    if (!rec || Date.parse(rec.expiresAt) <= this.now()) return null
    const token = unseal(key, rec.sealed)
    if (!token) return null
    data.codes = data.codes.filter((c) => c !== rec && Date.parse(c.expiresAt) > this.now())
    this.save(data)
    return { token, tokenId: rec.tokenId, name: rec.name }
  }

  private load(): PairCodeFile {
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8"))
        if (parsed && typeof parsed.salt === "string" && Array.isArray(parsed.codes)) return parsed
      } catch { /* rewritten below on the next save */ }
    }
    return { salt: randomBytes(16).toString("hex"), codes: [] }
  }

  /** Write to a temp file, then rename over the old one, so a reader never sees half a file. */
  private save(data: PairCodeFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

function derive(code: string, salt: string): { id: string; key: Buffer } {
  const out = scryptSync(code, Buffer.from(salt, "hex"), 64, SCRYPT)
  return {
    id: "sha256:" + createHash("sha256").update(out.subarray(0, 32)).digest("hex"),
    key: out.subarray(32),
  }
}

function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")
}

function unseal(key: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, "base64")
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf-8")
  } catch {
    return null
  }
}
