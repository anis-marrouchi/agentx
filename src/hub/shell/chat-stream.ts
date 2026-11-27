// --- The shell chat's live answer (#2101, req-01M83KYQ) ---
//
// Anis: "it shall be displaying whatever it has, streaming it back ... we
// shall not wait until everything is done". While an answer is pending its
// run streams on the node (/agents/<id>/tasks/<taskId>/stream), which the
// dashboard relays at /api/task/stream, as the old Hub panel reads it
// (wall-chat.client.ts). The chat shows the words as they come, then the
// stored answer once the thread read has it.
//
// The stream is the run's raw output: tool-call lines, results, thoughts,
// then the answer. cfParseLive (the old panel's reader) keeps the text after
// the last tool call. Some agents (graph-agent) write their answer as
// {"answer":"…"}; that wrapper is never shown, not even while it arrives.
import { useEffect, useRef, useState } from "react"
import { cfParseLive } from "../../daemon/ui/pages/wall-chat-fold"
import type { OutStamp } from "../../agents/output-stamps"
import type { SourceLike } from "../live"

/** The run's end marker in its output; 'end' follows it. */
export const TASK_FINISHED = "\n[task finished]\n"
/** Waits before opening a dropped stream again; then the thread read alone settles it. */
export const TASK_STREAM_RETRY_MS = [1000, 2000, 4000, 8000]

export function taskStreamUrl(node: string, agentId: string, taskId: string): string {
  return "/api/task/stream?node=" + encodeURIComponent(node) + "&agent=" + encodeURIComponent(agentId) + "&task=" + encodeURIComponent(taskId)
}

const WRAP = '{"answer":"'
const WRAP_OPEN = /^\s*\{\s*"answer"\s*:\s*"/
const ESC: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", "/": "/", "\\": "\\", '"': '"' }

/** The answer inside a {"answer":"…"} wrapper, read as far as it has come.
 *  `partial`: the text is still arriving, so the wrapper's own first
 *  characters ("{", "{\"ans") show nothing rather than themselves. Text
 *  that is not a wrapper comes back as it is. */
export function unwrapAnswer(text: string, partial = false): string {
  const s = String(text ?? "")
  const m = WRAP_OPEN.exec(s)
  if (!m) {
    if (!partial) return s
    const t = s.replace(/\s+/g, "")
    return t && WRAP.startsWith(t) ? "" : s
  }
  let out = ""
  for (let i = m[0].length; i < s.length; i++) {
    const c = s[i]
    if (c === '"') return out
    if (c !== "\\") { out += c; continue }
    const n = s[i + 1]
    if (n === undefined) break
    if (n === "u") {
      const hex = s.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
      out += String.fromCharCode(parseInt(hex, 16))
      i += 5
      continue
    }
    out += ESC[n] ?? n
    i++
  }
  return out
}

/** A stored answer: unwrapped only when it is the whole wrapper and nothing else. */
export function storedAnswer(content: string): string {
  const s = String(content ?? "")
  if (!WRAP_OPEN.test(s)) return s
  try {
    const o = JSON.parse(s)
    if (o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).length === 1 && typeof o.answer === "string") return o.answer
  } catch { /* not JSON: as it is */ }
  return s
}

/** The words of the answer so far, from the run's raw output. */
export function liveAnswer(raw: string): string {
  return unwrapAnswer(cfParseLive(raw).answer, true)
}

const openEventSource = (u: string): SourceLike => new EventSource(u, { withCredentials: true })

/** The start event, as the node sends it: the whole output so far and when
 *  each of its lines came in, the ask, and whether the run already ended. */
export interface TaskStreamStart {
  initial?: string; stamps?: OutStamp[]; message?: string; sender?: string; startedAt?: string; done?: boolean; endedAt?: string
}

export interface FollowOpts {
  /** Each start event (the first open and every reopen), before its text. */
  onStart?: (d: TaskStreamStart) => void
  open?: (url: string) => SourceLike
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

/** Reads one run's stream: `onText` gets the raw output so far (start's
 *  `initial`, then each chunk added, with the chunk and when it came). A dropped connection opens again
 *  after 1, 2, 4 and 8 s; the node's own error (an unknown run) ends it,
 *  and the thread read settles the answer. `onEnd` runs when the stream
 *  says the run is over. Returns the call that stops reading. */
export function followTaskStream(url: string, onText: (raw: string, chunk?: { text: string; at: number }) => void, onEnd: () => void, opts: FollowOpts = {}): () => void {
  const open = opts.open ?? openEventSource
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  let text = "", src: SourceLike | null = null, timer: unknown = null, tries = 0, stopped = false
  const close = () => { if (src) { try { src.close() } catch { /* already closed */ } } src = null }
  const connect = () => {
    if (stopped) return
    let s: SourceLike
    try { s = open(url) } catch { return }
    src = s
    // A reopen starts again from the output so far (start's initial).
    s.addEventListener("start", (ev: { data: string }) => {
      if (src !== s) return
      tries = 0
      try {
        const d = JSON.parse(ev.data) as TaskStreamStart
        opts.onStart?.(d)
        if (typeof d.initial === "string") { text = d.initial; onText(text) }
        if (d.done) { close(); onEnd() }
      } catch { /* not JSON: skip */ }
    })
    s.addEventListener("chunk", (ev: { data: string }) => {
      if (src !== s) return
      tries = 0
      try {
        const d = JSON.parse(ev.data)
        const t = d.text || ""
        if (!t || t === TASK_FINISHED) return
        text += t
        onText(text, { text: t, at: typeof d.at === "number" ? d.at : Date.now() })
      } catch { /* not JSON: skip */ }
    })
    s.addEventListener("end", () => { if (src !== s) return; close(); onEnd() })
    s.addEventListener("error", (ev: { data?: unknown }) => {
      if (src !== s) return
      close()
      const dropped = !(ev && ev.data)
      if (dropped && tries < TASK_STREAM_RETRY_MS.length) timer = setTimer(() => { timer = null; connect() }, TASK_STREAM_RETRY_MS[tries++])
    })
  }
  connect()
  return () => { stopped = true; if (timer != null) clearTimer(timer); timer = null; close() }
}

export interface TaskStreamTarget { node?: string | null; agentId?: string | null; taskId?: string | null }

/** The raw output of the run `target` names, while it streams; "" for none. */
export function useTaskStream(target: TaskStreamTarget, onEnd?: () => void): string {
  const { node, agentId, taskId } = target
  const [raw, setRaw] = useState("")
  const endRef = useRef(onEnd)
  endRef.current = onEnd
  useEffect(() => {
    setRaw("")
    if (!node || !agentId || !taskId || typeof window === "undefined" || !("EventSource" in window)) return
    return followTaskStream(taskStreamUrl(node, agentId, taskId), setRaw, () => endRef.current?.())
  }, [node, agentId, taskId])
  return raw
}
