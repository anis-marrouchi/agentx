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
 *  makeStreamEventFormatter). Each starts a segment. */
const SEGMENT_START = /\n(?=→ |← |💭 |· |\. |> codex |< codex |\[error\] |\[task finished\])/

/** Turns the daemon's formatted task output into phone events. Stateful:
 *  text since the last step is the "current" text, so at the end it is the
 *  final answer. */
export class PhoneStreamTrimmer {
  private current = ""
  private lastStep = ""
  failed = false

  /** One upstream chunk (or the start buffer) in, phone events out. */
  feed(chunk: string): PhoneEvent[] {
    const out: PhoneEvent[] = []
    let textChanged = false
    for (const raw of chunk.split(SEGMENT_START)) {
      const seg = raw.replace(/^\n+/, "")
      if (!seg) continue
      const tool = seg.match(/^→ ([^(\s]+)\(/)
      if (tool) {
        this.step(stepName(tool[1]), out)
        textChanged = false
        continue
      }
      const codex = seg.match(/^> codex (\S+)(?: ([^\n]*))?/)
      if (codex) {
        // The item's name only when it is a plain identifier: a shell
        // command or its arguments never reach the phone.
        const name = codex[2] && /^[\w.:-]+$/.test(codex[2].trim()) ? `${codex[1]} ${codex[2].trim()}` : codex[1]
        this.step(stepName(name), out)
        textChanged = false
        continue
      }
      if (/^\[error\] /.test(seg)) { this.failed = true; continue }
      // Tool results, thinking, init/done lines and the finish marker: not for the phone.
      if (/^(← |💭 |· |\. |< codex |\[task finished\])/.test(seg)) continue
      this.current += raw
      textChanged = true
    }
    if (textChanged && this.text()) out.push({ event: "text", data: { text: this.text() } })
    return out
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

  const snap = await deps.snapshot()
  const task = summarizeActivity(snap.nodes).find((t) => t.taskId === taskId && (!agentId || t.agentId === agentId))
  if (!task) return json(res, 404, { error: "this task has ended" })

  const abort = new AbortController()
  req.on("close", () => abort.abort())
  const up = await deps.taskStream(task.node, task.agentId, task.taskId, abort.signal)
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
          trim.feed(typeof data.initial === "string" ? data.initial : "")
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
