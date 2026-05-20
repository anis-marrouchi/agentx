// Minimal SSE consumer for the daemon's `/events` stream.
//
// Frames look like `event: <kind>\ndata: <json>\n\n`. We yield each parsed
// frame as { event, data } where data is the parsed JSON payload (or the
// raw string if it isn't JSON).

export interface SseFrame {
  event: string
  data: any
}

export interface SseStreamOptions {
  baseUrl: string
  token?: string
  /** Optional comma-separated event kinds (run,task,signal,mesh,channel,status). */
  type?: string
  signal?: AbortSignal
}

/**
 * Open an SSE connection and yield frames until the signal aborts or the
 * connection closes. Reconnect is the caller's job — for the TUI we just
 * surface a disconnect via the returned promise.
 */
export async function* streamEvents(opts: SseStreamOptions): AsyncGenerator<SseFrame> {
  const qs: string[] = []
  if (opts.type) qs.push(`type=${encodeURIComponent(opts.type)}`)
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/events${qs.length ? `?${qs.join("&")}` : ""}`

  const headers: Record<string, string> = { Accept: "text/event-stream" }
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`

  const res = await fetch(url, { headers, signal: opts.signal })
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const parsed = parseFrame(frame)
        if (parsed) yield parsed
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* noop */ }
  }
}

function parseFrame(frame: string): SseFrame | null {
  let event = "message"
  let data = ""
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7)
    else if (line.startsWith("data: ")) data = line.slice(6)
  }
  if (!data) return null
  let payload: any
  try { payload = JSON.parse(data) } catch { payload = data }
  return { event, data: payload }
}
