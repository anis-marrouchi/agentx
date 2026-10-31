// --- Links a phone can open (#1652) ---
//
// A push is tapped on the phone, so a link in it must be absolute and must
// not point at the machine that sent it: localhost on the phone is the
// phone. Both the ntfy adapter and `agentx notify --url` check with this.

const LOOPBACK_HOSTS = new Set(["localhost", "0.0.0.0", "[::1]", "[::]"])

/** An http(s) URL whose host is not this machine's loopback. */
export function isPhoneLink(value: string | undefined): value is string {
  if (!value) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false
  const host = url.hostname.toLowerCase()
  return !LOOPBACK_HOSTS.has(host) && !host.endsWith(".localhost") && !/^127\./.test(host)
}
