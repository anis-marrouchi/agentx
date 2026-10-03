// Guiding over HTTP (see src/voice/guide.ts).
//
//   GET  /voice/guide?after=<seq>   AgentX Voice waits here while the
//                                   character is on screen: the next
//                                   command, or the current one after 25 s.
//   POST /voice/guide               {rect: {x, y, width, height}, mark?: box |
//                                   circle | underline | none, agentId?,
//                                   hold?: seconds, text?}  send the character
//                                   there; its bubble says `text` at the stop,
//                                   and with none there is no bubble.
//                                   {home: true}  send it back.
//                                   409 when no character is on screen.

import { GUIDE_HOLD, GUIDE_MARKS, GUIDE_TEXT_MAX, guideText, type GuideFeed, type GuideMark } from "@/voice/guide"
import type { Rect } from "@/voice/presence"
import type { Reply } from "@/daemon/voice-talk-api"

export const isGuidePath = (path: string) => path === "/voice/guide"

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

function rectOf(v: unknown): Rect | null {
  const r = v as Record<string, unknown> | null
  if (!r || typeof r !== "object") return null
  const x = num(r.x), y = num(r.y), width = num(r.width), height = num(r.height)
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

export async function handleGuide(
  feed: GuideFeed,
  /** `voice.look` is "character". */
  character: boolean,
  method: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  /** The caller hung up: ends its wait. */
  gone?: AbortSignal,
): Promise<Reply> {
  if (method === "GET") return { status: 200, body: await feed.next(Number(query.get("after")) || 0, undefined, gone) }
  if (method !== "POST") return { status: 405, body: { error: "GET or POST" } }
  if (!character || !feed.listening) {
    return { status: 409, body: { shown: false, error: character ? "AgentX Voice is not showing the character" : "voice.look is not character" } }
  }
  const agentId = typeof body.agentId === "string" && body.agentId ? body.agentId : null
  if (body.home === true) return { status: 200, body: { shown: true, ...feed.home(agentId) } }
  const rect = rectOf(body.rect)
  const mark = (body.mark ?? "box") as GuideMark
  const hold = body.hold === undefined ? GUIDE_HOLD.default : num(body.hold)
  const text = body.text ?? ""
  if (!rect || !GUIDE_MARKS.includes(mark) || hold === null || hold <= 0 || hold > GUIDE_HOLD.max || typeof text !== "string") {
    return { status: 400, body: { error: `Required: rect {x, y, width, height}; mark is ${GUIDE_MARKS.join(" | ")}; hold is up to ${GUIDE_HOLD.max} seconds; text is a string, cut at ${GUIDE_TEXT_MAX} characters` } }
  }
  return { status: 200, body: { shown: true, ...feed.show(agentId, rect, mark, hold, guideText(text)) } }
}
