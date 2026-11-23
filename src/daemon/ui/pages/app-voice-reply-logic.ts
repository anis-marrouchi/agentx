// Pure helpers for "Reply by voice" on the phone (#2103), shipped to the
// browser with injectFns and tested in node. Each one is self-contained.

/** What a notification's link asks the app to open. */
export interface OpenTarget {
  tab: "desk" | "chat"
  /** desk: the card's key, such as request:r1. chat: the conversation id. */
  id: string
  /** Opened from "Reply by voice": the mic is shown ready, never started. */
  voice: boolean
}

/** Reads #desk=<key>[&voice=1] or #chat=<id>[&voice=1]. Null for any other
 *  hash, and for a key or id that is not well formed. */
export function parseOpenHash(hash: string): OpenTarget | null {
  const m = /^#(desk|chat)=([^&]+)(&voice=1)?$/.exec(String(hash || ""))
  if (!m) return null
  let id = ""
  try { id = decodeURIComponent(m[2]) } catch { return null }
  if (m[1] === "chat" && !/^c[a-z0-9]{8,32}$/.test(id)) return null
  if (m[1] === "desk" && !/^[a-z-]{2,32}:[A-Za-z0-9._:/-]{1,200}$/.test(id)) return null
  return { tab: m[1] as "desk" | "chat", id, voice: !!m[3] }
}

/** What the dictation button says in each state. */
export function dictateLabel(state: "idle" | "ready" | "listening" | "sending"): string {
  if (state === "listening") return "Listening… tap to stop"
  if (state === "sending") return "Writing it down…"
  if (state === "ready") return "Tap to speak your answer"
  return "Speak"
}
