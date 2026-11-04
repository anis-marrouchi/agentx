// A workflow run's context holds whatever its trigger carried. Run files and
// the run API show that context as it is, so a credential has to go before
// it gets there. Only string values go: usage counts like
// `usage.inputTokens` and a flag like `hasSecret` are not credentials.

const SECRET_KEY = /(token|secret|password|passwd|apikey|authorization)$/

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.toLowerCase().replace(/[_-]/g, ""))
}

/** A copy of `value` without string fields named like a credential, at any
 *  depth. The field is removed, not masked, so a reader sees it is absent. */
export function stripSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripSecrets) as T
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && isSecretKey(k)) continue
    out[k] = stripSecrets(v)
  }
  return out as T
}
