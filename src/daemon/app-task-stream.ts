import type { IncomingMessage, ServerResponse } from "http"
import { PREVIEW_CHARS, clip, summarizeActivity, type SnapshotNode, type TaskStreamOpen } from "./app-fleet"

// --- Phone app: follow one running task (GET /api/app/tasks/stream) ---
//
// #2103 PR B. The Live sheet follows a task the phone found in
// /api/app/activity. Three rules shape this route:
//
//   1. The phone never names a node. It sends taskId (and agentId); the
//      server finds the task in the same live snapshot /api/app/activity
//      reads and takes the node URL from there. A task not in the snapshot
//      gets 404 "this task has ended".
//   2. Previews only, as everywhere in the phone app (app-fleet.ts). The
//      task's raw output never passes through. The phone gets step and tool
//      NAMES, the state, and the latest text cut to PREVIEW_CHARS. Tool
//      inputs, tool results, thinking and error text are dropped; a run
//      that hit an error ends as "failed" with no error text.
//   3. Only phones with the `app:live` scope get here (app-routes.ts passes
//      that in); the others get 403 with the command that turns it on.
//
// Events sent to the phone:
//   start {taskId, agentId, agentName, nodeName, preview, startedAt, step?, text?}
//   step  {name}
//   text  {text}                       latest text, ≤ PREVIEW_CHARS
//   end   {state: "done"|"failed"|"ended", final?, more: "Full answer on the Hub"}

const TEXT_EVERY_MS = 700
const STEP_NAME_MAX = 60
/** TASK_OUTPUT_BUFFER_MAX in registry.ts: how much output a node keeps. */
const NODE_BUFFER_MAX = 64 * 1024

export interface AppTaskStreamDeps {
  snapshot(): Promise<{ ts: string; nodes: SnapshotNode[] }>
  /** Open the node daemon's task SSE through the dashboard's allowlist,
   *  with the dashboard's token for that node. */
  taskStream(nodeUrl: string, agentId: string, taskId: string, signal: AbortSignal): Promise<TaskStreamOpen>
}

export type PhoneEvent =
  | { event: "step"; data: { name: string } }
  | { event: "text"; data: { text: string } }

/** Marker lines the daemon's stream formatter writes (registry.ts
 *  makeStreamEventFormatter, and the thinking/text wrappers for runtimes
 *  that are not claude-code). Each starts a segment. */
const MARKER = String.raw`→ |← |💭 |· |\. |> codex |< codex |\[error\] |\[task finished\]`
const STARTS_WITH_MARKER = new RegExp(`^(?:${MARKER})`)
/** A marker after a newline starts a segment. */
const SEGMENT_START = new RegExp(`\\n(?=${MARKER})`)
/** Markers that also start a segment with no newline before them (#2137
 *  review B2), read ONLY in the start buffer (feedStart). A daemon older
 *  than this fix writes a marker right after a text delta, glued to it:
 *  `…working on it[error] API key invalid`. Live chunks are never searched
 *  for them: an answer that quotes "[error] connection refused", "A ← B" or
 *  "Step 1 · done" would mark the run failed and cut the answer (Hakim on
 *  #2148). Live, a marker starts a segment only after a newline or at the
 *  start of a chunk, and the daemon now writes a newline before every
 *  marker line (registry.ts makeStreamEventFormatter). Only markers that
 *  do not read as prose: not `→ ` (always written after a newline) and not
 *  `. ` (ends every sentence). */
const GLUED_MARKER = /← |💭 |· (?:done|init)\b|< codex |\[error\] |\[task finished\]/

/** Turns the daemon's formatted task output into phone events. Stateful:
 *  text since the last step is the "current" text, so at the end it is the
 *  final answer.
 *
 *  Privacy rule (#2137 review B1): a segment that is not for the phone
 *  (thinking, a tool result, an error, …) runs until the next marker inside
 *  a chunk, and on into the next chunks until a newline. Runtimes that are
 *  not claude-code send thinking token by token with `💭 ` only on the
 *  first token, so the kind has to outlive the chunk; the daemon starts
 *  every new thinking line with `💭 ` again and ends the thought with a
 *  newline before the answer (registry.ts). */
export class PhoneStreamTrimmer {
  private current = ""
  private lastStep = ""
  /** The last chunk ended inside a dropped segment, with no newline yet. */
  private dropping = false
  /** The last chunk ended with a newline (or nothing came yet). */
  private lineStart = true
  failed = false

  /** One upstream chunk in, phone events out. `glued` is for the start
   *  buffer only (see GLUED_MARKER). */
  feed(chunk: string, glued = false): PhoneEvent[] {
    const out: PhoneEvent[] = []
    let textChanged = false
    let lastDropped = this.dropping
    const parts = chunk.split(SEGMENT_START)
    for (let k = 0; k < parts.length; k++) {
      let seg = parts[k]
      if (k === 0 && this.dropping) {
        // The chunk goes on with the segment the last chunk dropped: still
        // dropped up to its first newline, marker look-alikes included.
        const nl = seg.indexOf("\n")
        if (nl === -1) continue
        seg = seg.slice(nl + 1)
      }
      if (!seg) continue
      // A chunk that goes on with the line before it starts with a marker
      // only if that is a thought: a text delta like ". Next I will…" is
      // answer text (#2137 review B2, Hakim on #2148). The daemon writes a
      // newline before every marker line; `💭 ` stays for older daemons, as
      // no answer chunk starts with it.
      const midLine = k === 0 && !this.lineStart && !lastDropped
      const startsWithMarker = midLine ? seg.startsWith("💭 ") : STARTS_WITH_MARKER.test(seg)
      // Text, up to a marker glued to it (start buffer only; none if the
      // segment starts with one).
      const at = startsWithMarker ? 0 : glued ? seg.search(GLUED_MARKER) : -1
      const text = at === -1 ? seg : seg.slice(0, at)
      if (text) {
        this.current += text
        textChanged = true
        lastDropped = false
      }
      if (at === -1) continue
      if (this.marker(seg.slice(at), out)) textChanged = false
      lastDropped = true
    }
    // Still inside a dropped segment if the chunk ended in one, before its
    // newline.
    this.dropping = lastDropped && !chunk.endsWith("\n")
    if (chunk) this.lineStart = chunk.endsWith("\n")
    if (textChanged && this.text()) out.push({ event: "text", data: { text: this.text() } })
    return out
  }

  /** A segment that starts with a marker: a step name, a failure, or
   *  nothing (tool results, thinking, init/done lines, the finish marker,
   *  a look-alike tool line). True when it was a step. */
  private marker(seg: string, out: PhoneEvent[]): boolean {
    const tool = seg.match(/^→ ([^(\s]+)\(/)
    if (tool) { this.step(stepName(tool[1]), out); return true }
    const codex = seg.match(/^> codex (\S+)(?: ([^\n]*))?/)
    if (codex) {
      // The item's name only when it is a plain identifier: a shell
      // command or its arguments never reach the phone.
      const name = codex[2] && /^[\w.:-]+$/.test(codex[2].trim()) ? `${codex[1]} ${codex[2].trim()}` : codex[1]
      this.step(stepName(name), out)
      return true
    }
    if (/^\[error\] /.test(seg)) this.failed = true
    return false
  }

  /** The start buffer. A node keeps only the last NODE_BUFFER_MAX chars of
   *  a task's output, so a full buffer can begin inside a thought or a tool
   *  result: drop up to its first marker line. */
  feedStart(initial: string): PhoneEvent[] {
    if (initial.length < NODE_BUFFER_MAX) return this.feed(initial, true)
    const at = initial.search(SEGMENT_START)
    if (at === -1) { this.dropping = true; this.lineStart = initial.endsWith("\n") }
    return this.feed(at === -1 ? "" : initial.slice(at), true)
  }

  /** The latest text, flattened and cut to PREVIEW_CHARS from the end. */
  text(): string {
    const flat = this.current.replace(/\s+/g, " ").trim()
    return flat.length > PREVIEW_CHARS ? "…" + flat.slice(flat.length - (PREVIEW_CHARS - 1)) : flat
  }

  /** The final answer's start, cut to PREVIEW_CHARS. */
  final(): string | undefined {
    return clip(this.current) || undefined
  }

  step(): string
  step(name: string, out: PhoneEvent[]): void
  step(name?: string, out?: PhoneEvent[]): string | void {
    if (name === undefined) return this.lastStep
    this.lastStep = name
    this.current = ""
    out!.push({ event: "step", data: { name } })
  }
}

function stepName(s: string): string {
  return s.length > STEP_NAME_MAX ? s.slice(0, STEP_NAME_MAX - 1) + "…" : s
}

/** Splits an SSE byte stream into {event, data} frames. */
export class SseFrames {
  private buf = ""
  push(text: string): Array<{ event: string; data: string }> {
    this.buf += text.replace(/\r\n/g, "\n")
    const frames: Array<{ event: string; data: string }> = []
    let i: number
    while ((i = this.buf.indexOf("\n\n")) !== -1) {
      const block = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 2)
      let event = "message"
      const data: string[] = []
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      if (data.length) frames.push({ event, data: data.join("\n") })
    }
    return frames
  }
}

/** GET /api/app/tasks/stream?taskId=…&agentId=… for a phone already known
 *  to carry `app:live`. */
export async function handleAppTaskStream(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AppTaskStreamDeps,
): Promise<true> {
  if (url.searchParams.has("node")) return json(res, 400, { error: "the phone does not choose the node; send taskId only" })
  const taskId = (url.searchParams.get("taskId") || "").trim()
  const agentId = (url.searchParams.get("agentId") || "").trim()
  if (!taskId) return json(res, 400, { error: "taskId is required" })

  // Before the first await: a phone that leaves while the snapshot or the
  // node is slow must not leave the upstream open until the task ends.
  // The response's close fires when the phone's connection goes, at any
  // point (and after our own end, where aborting does nothing).
  const abort = new AbortController()
  res.on("close", () => abort.abort())
  const snap = await deps.snapshot()
  if (abort.signal.aborted) return true
  const task = summarizeActivity(snap.nodes).find((t) => t.taskId === taskId && (!agentId || t.agentId === agentId))
  if (!task) return json(res, 404, { error: "this task has ended" })

  const up = await deps.taskStream(task.node, task.agentId, task.taskId, abort.signal)
  if (abort.signal.aborted) {
    if (up.ok) up.body.cancel().catch(() => {})
    return true
  }
  if (!up.ok) {
    const msg = up.status === 403 ? `${task.nodeName} does not let this computer follow its tasks`
      : up.status === 404 ? "this task has ended"
      : `${task.nodeName} could not be reached`
    return json(res, up.status === 404 ? 404 : 502, { error: msg })
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  })
  let closed = false
  const send = (event: string, data: unknown) => {
    if (closed) return
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) } catch { closed = true }
  }
  const heartbeat = setInterval(() => { if (!closed) try { res.write(": ping\n\n") } catch { closed = true } }, 15000)
  heartbeat.unref?.()

  const trim = new PhoneStreamTrimmer()
  let lastTextAt = 0
  let pendingText: string | null = null
  let textTimer: ReturnType<typeof setTimeout> | null = null
  const flushText = () => {
    if (textTimer) { clearTimeout(textTimer); textTimer = null }
    if (pendingText === null) return
    send("text", { text: pendingText })
    pendingText = null
    lastTextAt = Date.now()
  }
  const emit = (events: PhoneEvent[]) => {
    for (const e of events) {
      if (e.event === "text") {
        pendingText = e.data.text
        const wait = TEXT_EVERY_MS - (Date.now() - lastTextAt)
        if (wait <= 0) flushText()
        else if (!textTimer) textTimer = setTimeout(flushText, wait)
      } else {
        flushText()
        send(e.event, e.data)
      }
    }
  }
  let ended = false
  const end = (state: "done" | "failed" | "ended") => {
    if (ended) return
    ended = true
    flushText()
    const final = state === "ended" ? undefined : trim.final()
    send("end", { state, ...(final ? { final } : {}), more: "Full answer on the Hub" })
    closed = true
    clearInterval(heartbeat)
    abort.abort()
    try { res.end() } catch { /* */ }
  }
  const finishState = () => (trim.failed ? "failed" : "done")

  const frames = new SseFrames()
  const decoder = new TextDecoder()
  const reader = up.body.getReader()
  try {
    while (!closed) {
      const { value, done } = await reader.read()
      if (done) break
      for (const f of frames.push(decoder.decode(value, { stream: true }))) {
        let data: any = {}
        try { data = JSON.parse(f.data) } catch { continue }
        if (f.event === "start") {
          trim.feedStart(typeof data.initial === "string" ? data.initial : "")
          send("start", {
            taskId: task.taskId,
            agentId: task.agentId,
            agentName: task.agentName,
            nodeName: task.nodeName,
            preview: task.preview,
            startedAt: task.startedAt,
            ...(trim.step() ? { step: trim.step() } : {}),
            ...(trim.text() ? { text: trim.text() } : {}),
          })
          if (data.done) end(finishState())
        } else if (f.event === "chunk") {
          emit(trim.feed(typeof data.text === "string" ? data.text : ""))
        } else if (f.event === "end") {
          end(finishState())
        } else if (f.event === "error") {
          end("ended")
        }
      }
    }
  } catch { /* upstream dropped: the phone reconnects once, then says lost */ }
  if (!ended) {
    // Upstream closed without an end frame: let the phone decide (it
    // reconnects once). Close without an end event.
    flushText()
    closed = true
    clearInterval(heartbeat)
    try { res.end() } catch { /* */ }
  }
  return true
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
