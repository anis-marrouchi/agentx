// Where the Hub lives and which pages belong to it. Kept free of Electron
// so the rules can be tested with plain Node (test/hub.test.mjs).

export const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4202"

/** The dashboard base URL: AGENTX_DASHBOARD_URL, else this machine's default port. */
export function dashboardUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.AGENTX_DASHBOARD_URL || "").trim() || DEFAULT_DASHBOARD_URL
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return DEFAULT_DASHBOARD_URL
    return u.origin + u.pathname.replace(/\/+$/, "")
  } catch {
    return DEFAULT_DASHBOARD_URL
  }
}

export function hubUrl(base: string): string {
  return base + "/hub"
}

/** True when `url` is on the dashboard's own origin (scheme, host and port). */
export function isDashboardOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}

/** Links the app hands to the system browser or mail client instead of opening them in its window. */
export function opensOutside(url: string, base: string): boolean {
  if (isDashboardOrigin(url, base)) return false
  try {
    const p = new URL(url).protocol
    return p === "http:" || p === "https:" || p === "mailto:"
  } catch {
    return false
  }
}

/**
 * The only device the window may use is the microphone, and only for the
 * dashboard's own pages (the Hub's voice controls). Camera, screen and
 * other sites are refused.
 */
export function allowsMedia(origin: string, base: string, mediaTypes: readonly string[] | undefined): boolean {
  if (!isDashboardOrigin(origin, base)) return false
  const types = mediaTypes ?? []
  return types.length > 0 && types.every((t) => t === "audio")
}
