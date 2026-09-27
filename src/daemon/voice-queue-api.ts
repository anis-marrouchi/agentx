// The speaking queue over HTTP (see src/voice/speaking-queue.ts). One
// queue holds everything spoken on this host, so an agent or a client
// can see who is speaking and who waits, and AgentX Voice queues its
// answers here instead of playing them over everyone else.
//
//   GET  /voice/queue          {paused, playing, waiting, recent}
//   POST /voice/queue          {text, agentId, kind?, wait?}  queue a line in
//                              the agent's voice. 202 {item}; with wait: true
//                              the reply comes once the line is done:
//                              200 {item, played}.
//   POST /voice/queue/:id/skip    drop a line, playing or waiting
//   POST /voice/queue/:id/front   play a waiting line next
//   POST /voice/queue/:id/replay  say a queued or recent line again, next
//   POST /voice/queue/pause    hold the queue (the line playing is cut and
//                              plays again on resume); resumes by itself
//                              after a minute. /voice/hush pauses it too.
//   POST /voice/queue/resume   play on: a client whose listener said
//                              nothing, so no /voice/door follows the hush
//
// Changes also go out on /events as `voice` frames (kind "voice:queue").
// Same gate as /ask: each of these makes the host speak.

import type { VoiceRef } from "@/voice/speaker"
import type { QueueItem, QueueView, SpeechKind, SpeechOut } from "@/voice/speaking-queue"
import type { Reply } from "@/daemon/voice-talk-api"

/** What a client may queue; talks and lessons queue their own lines. */
const CLIENT_KINDS: SpeechKind[] = ["answer", "narration", "line"]
const MAX_TEXT = 5_000

export function isQueuePath(path: string): boolean {
  return path === "/voice/queue" || path.startsWith("/voice/queue/")
}

export async function handleQueue(
  speech: SpeechOut,
  voiceOf: (agentId: string) => VoiceRef | null,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Reply> {
  if (path === "/voice/queue") {
    if (method === "GET") return { status: 200, body: speech.view() }
    if (method !== "POST") return { status: 405, body: { error: "GET or POST" } }
    const text = String(body.text ?? "").trim()
    const agentId = String(body.agentId ?? body.agent ?? "")
    const kind = String(body.kind ?? "line") as SpeechKind
    if (!text || !agentId || !CLIENT_KINDS.includes(kind)) return { status: 400, body: { error: `Required: text and agentId; kind is ${CLIENT_KINDS.join(" | ")}` } }
    if (text.length > MAX_TEXT) return { status: 413, body: { error: `text is over ${MAX_TEXT} characters` } }
    const voice = voiceOf(agentId)
    if (!voice) return { status: 404, body: { error: `Unknown agent: ${agentId}` } }
    const { item, done } = speech.enqueue({ voice, text, agentId, kind })
    if (body.wait !== true) return { status: 202, body: { item } }
    return { status: 200, body: { item, played: await done } }
  }

  if (method === "POST" && path === "/voice/queue/pause") { speech.pause(); return { status: 200, body: speech.view() } }
  if (method === "POST" && path === "/voice/queue/resume") { speech.resume(); return { status: 200, body: speech.view() } }
  // Item ids are plain ASCII ("s…-12"): no decoding needed.
  const [, , , id, action, extra] = path.split("/")
  if (method !== "POST" || !id || extra !== undefined) return { status: 404, body: { error: "Not found" } }
  switch (action) {
    case "skip":
      return speech.skip(id) ? { status: 200, body: speech.view() } : unknown(id)
    case "front":
      return speech.front(id) ? { status: 200, body: speech.view() } : unknown(id)
    case "replay": {
      const item = speech.replay(id)
      return item ? { status: 202, body: { item } } : unknown(id)
    }
    default:
      return { status: 404, body: { error: "Not found" } }
  }
}

/** The queue in a few plain lines, for an agent that asks (MCP tool
 *  agentx_voice_queue) rather than having it in every turn. */
export function describeQueue(v: QueueView): string {
  const who = (i: QueueItem) => `${i.agentId ?? "someone"} (${i.kind}): "${i.text.length > 80 ? `${i.text.slice(0, 79)}…` : i.text}" [${i.id}]`
  const head = v.playing ? `Speaking: ${who(v.playing)}`
    : v.paused ? "Paused: the listener is speaking; the queue plays on after." : "Nothing is speaking."
  return [head, ...v.waiting.map((i, n) => `${n + 1}. waiting: ${who(i)}`)].join("\n")
}

const unknown = (id: string): Reply => ({ status: 404, body: { error: `No such line in the queue: ${id}` } })
