import { createHmac, timingSafeEqual } from "crypto"

// --- X-Wacli-Signature ---
//
// `wacli sync --webhook-secret S` signs the exact body it posts:
//   X-Wacli-Signature: sha256=<hex HMAC-SHA256(S, body)>
// (openclaw/wacli internal/app/webhook.go). Verified over the raw bytes,
// before anything is parsed. No secret configured means no request passes.

export function wacliSignature(secret: string, body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex")
}

export function verifyWacliSignature(secret: string | undefined, body: Buffer, header: string | string[] | undefined): boolean {
  if (!secret) return false
  const given = Array.isArray(header) ? header[0] : header
  if (!given || !/^sha256=[0-9a-f]{64}$/i.test(given.trim())) return false
  const expected = Buffer.from(wacliSignature(secret, body))
  const actual = Buffer.from(given.trim().toLowerCase())
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
