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
