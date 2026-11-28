// --- The daemon's own call prompts, as a system line (#2101) ---
//
// When a voice call is answered or ends, the daemon sends the agent a prompt
// of its own (service.ts callOpener, SUMMARY_PROMPT) on the call's chat. The
// owner never typed it, so no chat or Task page draws it as their message:
// it shows as a short centred line ("Call answered", "Call ended").
//
// Self-contained: pages ship it to the browser with injectFns.

/** "Call answered" or "Call ended" for a daemon call prompt, else "". */
export function callNote(text: unknown): string {
  const s = String(text == null ? "" : text).trimStart()
  if (s.indexOf("[Call answered]") === 0) return "Call answered"
  if (s.indexOf("[Call ended]") === 0) return "Call ended"
  return ""
}
