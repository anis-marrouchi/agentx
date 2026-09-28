// --- Pure pairing helpers shared by the phone app's browser scripts ---
//
// Each function here is sent to the browser with injectFns() (see
// ../inject.ts), so the page, the service worker and the tests all run the
// same code. Keep every function self-contained: no imports, no calls to
// another helper, no references to module constants — the minifier renames
// those and the injected copy would lose them.

/** What the service worker does after /app answered 401 and it asked
 *  /api/app/me itself (#234).
 *  - "retry": the probe was accepted, so the phone IS paired and only that
 *    navigation lost its cookie. Fetch /app again, or serve the saved shell.
 *  - "lock": the probe was refused too. The phone really is unpaired, so
 *    drop the saved shell and keep the locked page for offline starts.
 *  - "keep": no answer (offline, server error). Show what the server sent
 *    but change no cache, so one bad moment can't unpair the app. */
export function afterUnauthorized(probeStatus: number): "retry" | "lock" | "keep" {
  if (probeStatus >= 200 && probeStatus < 300) return "retry"
  if (probeStatus === 401) return "lock"
  return "keep"
}

/** Whether the locked page may send the phone back to /app after its own
 *  /api/app/me probe succeeded. Once per 30 s at most: if /app kept
 *  answering 401 while the probe kept succeeding, bouncing forever would
 *  lock the phone in a reload loop, so the second time it shows the form. */
export function mayBounce(lastBounceAt: number | null, now: number): boolean {
  return !lastBounceAt || now - lastBounceAt >= 30000 || lastBounceAt > now
}

/** The pairing-code field as the owner types or pastes (#234): capitals,
 *  only symbols a code can hold (CODE_ALPHABET in pair-codes.ts), and the
 *  dash after the fourth. `caret` is where the cursor was in `raw`; the
 *  result keeps it after the same symbol, so editing mid-code still works.
 *  "abcdefgh" → "ABCD-EFGH". */
export function formatPairInput(raw: string, caret: number): { value: string; caret: number } {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
  const upper = String(raw || "").toUpperCase()
  const at = Math.max(0, Math.min(Number(caret) || 0, upper.length))
  let out = ""
  let before = 0
  for (let i = 0; i < upper.length && out.length < 8; i++) {
    if (alphabet.indexOf(upper.charAt(i)) < 0) continue
    out += upper.charAt(i)
    if (i < at) before++
  }
  const value = out.length > 4 ? out.slice(0, 4) + "-" + out.slice(4) : out
  return { value, caret: Math.min(before > 4 ? before + 1 : before, value.length) }
}

export type PairScan =
  | { kind: "token"; token: string }
  | { kind: "code"; code: string }
  | { kind: "none" }

/** What a scanned QR code holds. The QR from `agentx app pair` is a link
 *  `<address>/app/pair#token=agx_live_…`; that address may differ from the
 *  one the app was opened on (another Tailscale name, `--url`), so any
 *  http(s) origin is accepted and only the token is used. A bare code
 *  `XXXX-XXXX` also counts. Anything else is "none". */
export function parsePairScan(text: string): PairScan {
  const s = String(text || "").trim()
  const link = /^https?:[/][/][^/#?]+[/]app[/]pair[/]?#(.*)$/i.exec(s)
  if (link) {
    const parts = link[1].split("&")
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].indexOf("token=") !== 0) continue
      let token = ""
      try { token = decodeURIComponent(parts[i].slice(6)) } catch (e) { return { kind: "none" } }
      return /^agx_live_[0-9a-f]{64}$/.test(token) ? { kind: "token", token } : { kind: "none" }
    }
    return { kind: "none" }
  }
  const up = s.toUpperCase()
  if (/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(up)) return { kind: "code", code: up.slice(0, 4) + "-" + up.slice(-4) }
  return { kind: "none" }
}
