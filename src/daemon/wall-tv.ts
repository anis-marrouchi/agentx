// --- AgentX TV routes (#1471, experimental) ---
//
//   GET /wall/tv                         the TV page (ui/pages/wall-tv.ts)
//   GET /api/admin/tv?day=YYYY-MM-DD     a day's line-up (today by default)
//   GET /wall/tv/media/<day>/<id>.mp4    one episode's video
//
// The video sits beside the page, not under /api: a <video> element cannot
// send the Authorization header, so it is gated like the page (this
// machine, or a signed-in browser's cookie). Read-only: episodes are made
// by `agentx tv make`, never from the dashboard.

import { createReadStream, statSync } from "fs"
import type { IncomingMessage, ServerResponse } from "http"
import { localDay } from "@/tv/activity"
import { episodeDays, isDay, lineup, videoFile } from "@/tv/store"

export const TV_PAGE_PATH = "/wall/tv"
export const TV_API_PATH = "/api/admin/tv"
const MEDIA = /^\/wall\/tv\/media\/(\d{4}-\d{2}-\d{2})\/([a-z0-9][a-z0-9-]{0,63})\.mp4$/

export function isTvMediaPath(path: string): boolean {
  return MEDIA.test(path)
}

/** A day's line-up, the days that have one, and each video's address. */
export function tvLineupReply(params: URLSearchParams, opts: { root?: string; today?: string } = {}): { status: number; body: unknown } {
  const today = opts.today ?? localDay()
  const day = params.get("day") || today
  if (!isDay(day)) return { status: 400, body: { error: "day wants YYYY-MM-DD" } }
  const episodes = lineup(day, opts.root).map((ep) => ({
    ...ep,
    videoUrl: ep.video ? `/wall/tv/media/${ep.day}/${ep.id}.mp4` : null,
  }))
  return { status: 200, body: { day, today, days: episodeDays(opts.root), episodes } }
}

/** Stream one episode's video, with byte ranges for seeking. */
export function serveTvVideo(req: IncomingMessage, res: ServerResponse, path: string, root?: string): void {
  const m = MEDIA.exec(path)
  const file = m ? videoFile(m[1], m[2], root) : null
  let size = 0
  try { size = file ? statSync(file).size : 0 } catch { /* gone */ }
  if (!file || !size) {
    res.writeHead(404, { "Content-Type": "text/plain" })
    res.end("no such video")
    return
  }
  const base = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""))
  if (!range || (!range[1] && !range[2])) {
    res.writeHead(200, { ...base, "Content-Length": size })
    createReadStream(file).pipe(res)
    return
  }
  // "bytes=-500" is the last 500 bytes; "bytes=500-" is from 500 to the end.
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  if (start >= size || start > end) {
    res.writeHead(416, { "Content-Range": `bytes */${size}` })
    res.end()
    return
  }
  res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 })
  createReadStream(file, { start, end }).pipe(res)
}
