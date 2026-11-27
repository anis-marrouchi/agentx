// --- A run's live output, for the Files tab's current run (#2455) ---
//
// The same stream the old chat reads while an answer is pending
// (wall-chat.client.ts stream(): GET /api/task/stream). Its 'start' event
// brings the output so far, each 'chunk' adds to it, 'end' closes it. The
// output is the run's transcript as it grows, one `→ Tool({json})` line per
// tool call, so wall-files.ts runFilesOf reads the files from it as it does
// from a finished run's record.
import { useEffect, useState } from "react"

export interface StreamRun { node: string; agent: string; task: string }

/** The part of EventSource this hook uses, so tests can pass a fake. */
export interface RunSource {
  addEventListener(type: string, fn: (ev: MessageEvent<string>) => void): void
  close(): void
}

const FINISHED = "\n[task finished]\n"

/** Feed one stream event into the output so far. Null: the stream is over. */
export function streamStep(text: string, type: string, data: string): string | null {
  if (type === "end") return null
  let d: { initial?: string; text?: string; done?: boolean } = {}
  try { d = JSON.parse(data) } catch { return text }
  if (type === "start") return d.done ? null : typeof d.initial === "string" ? d.initial : text
  if (type === "chunk") return d.text && d.text !== FINISHED ? text + d.text : text
  return text
}

const streamUrl = (r: StreamRun) =>
  "/api/task/stream?" + new URLSearchParams({ node: r.node, agent: r.agent, task: r.task }).toString()

/** The run's output while `live`; kept once it ends, until the run changes.
 *  `reopen` changes when the owner asks for a reload. */
export function useRunStream(
  run: StreamRun | null, live: boolean, reopen = 0,
  open: (url: string) => RunSource = (u) => new EventSource(u, { withCredentials: true }),
): string {
  const key = run ? `${run.node}|${run.agent}|${run.task}` : ""
  const [out, setOut] = useState({ key, text: "" })
  useEffect(() => { setOut((o) => (o.key === key ? o : { key, text: "" })) }, [key])
  useEffect(() => {
    if (!run || !live) return
    let es: RunSource | null = open(streamUrl(run))
    let text = ""
    const stop = () => { es?.close(); es = null }
    const on = (type: string) => (ev: MessageEvent<string>) => {
      if (!es) return
      const next = streamStep(text, type, String(ev?.data ?? ""))
      if (next === null) { stop(); return }
      if (next !== text) { text = next; setOut({ key, text }) }
    }
    es.addEventListener("start", on("start"))
    es.addEventListener("chunk", on("chunk"))
    es.addEventListener("end", on("end"))
    // A drop or an unknown run: stop here. The thread read settles the run
    // when it ends, and the Files tab then reads its record.
    es.addEventListener("error", () => stop())
    return stop
    // `run` is named by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, reopen])
  return out.key === key ? out.text : ""
}
