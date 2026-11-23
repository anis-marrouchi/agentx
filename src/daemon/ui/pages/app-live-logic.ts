// --- Phone app: Live sheet logic (#2103 PR B) ---
//
// Pure functions the Live sheet (app-live.client.ts) gets through
// injectFns, so they are tested here and not only in a browser. No
// closures over module scope: injectFns copies each function's source.

/** Splits SSE text into frames. Returns the complete frames and the
 *  unfinished rest to keep for the next read. */
export function liveSseFrames(buf: string): { frames: Array<{ event: string; data: string }>; rest: string } {
  const text = buf.replace(/\r\n/g, "\n")
  const frames: Array<{ event: string; data: string }> = []
  let start = 0
  let i = text.indexOf("\n\n", start)
  while (i !== -1) {
    const block = text.slice(start, i)
    start = i + 2
    let event = "message"
    const data: string[] = []
    for (const line of block.split("\n")) {
      if (line.indexOf("event:") === 0) event = line.slice(6).trim()
      else if (line.indexOf("data:") === 0) data.push(line.slice(5).replace(/^ /, ""))
    }
    if (data.length) frames.push({ event, data: data.join("\n") })
    i = text.indexOf("\n\n", start)
  }
  return { frames, rest: text.slice(start) }
}

export interface LiveView {
  phase: "connecting" | "running" | "done" | "failed" | "ended" | "lost"
  step: string
  steps: number
  text: string
  final: string
  more: string
}

/** The sheet's state after one event from /api/app/tasks/stream. */
export function liveReduce(view: LiveView, event: string, data: any): LiveView {
  const v: LiveView = { phase: view.phase, step: view.step, steps: view.steps, text: view.text, final: view.final, more: view.more }
  if (event === "start") {
    v.phase = "running"
    if (data && data.step) { v.step = String(data.step); v.steps = Math.max(v.steps, 1) }
    if (data && data.text) v.text = String(data.text)
  } else if (event === "step") {
    v.step = String((data && data.name) || "")
    v.steps += 1
    v.text = ""
  } else if (event === "text") {
    v.text = String((data && data.text) || "")
  } else if (event === "end") {
    const s = data && data.state
    v.phase = s === "failed" ? "failed" : s === "ended" ? "ended" : "done"
    v.final = String((data && data.final) || "")
    v.more = String((data && data.more) || "")
  }
  return v
}

/** The one-line state the sheet shows. */
export function liveLabel(view: LiveView): string {
  switch (view.phase) {
    case "connecting": return "Connecting…"
    case "running": return view.step ? "Working · " + view.step : "Working"
    case "done": return "Done"
    case "failed": return "Failed"
    case "ended": return "This task has ended"
    default: return "Lost the connection"
  }
}
