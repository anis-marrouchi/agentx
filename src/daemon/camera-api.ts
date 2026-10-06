// An agent watching the phone camera, over HTTP (src/camera/watch.ts, #325).
//
//   POST /webrtc/camera/watch           {callId, agentId}: the agent's bot joins
//                                       the share; the phone answers its offer.
//                                       201 {watch}; 404 unknown agent; 409 the
//                                       agent already watches one. When callId
//                                       is a camera ask (phase 3), the owner
//                                       must have answered it (tapped Show),
//                                       it must be that agent's, and the watch
//                                       runs in the chat the ask came from;
//                                       403 / 409 otherwise
//   GET  /webrtc/camera/watch           {active: [watch]}
//   GET  /webrtc/camera/watch/:id       {watch}: frames so far and the replies
//   POST /webrtc/camera/watch/:id/look  {note?}: the owner asks what the agent
//                                       sees. Runs one turn; 200 {reply, frame};
//                                       409 before the first frame
//   POST /webrtc/camera/watch/:id/stream {seconds, note?}: "Keep watching"
//                                       (#687): a frame every
//                                       streamFrameSeconds for that long, at
//                                       most streamMaxSeconds; 0 stops it.
//                                       200 {watch}
//   POST /webrtc/camera/watch/:id/stop  ends the watch
//   POST /webrtc/camera/look            {agentId} with X-AgentX-Task, or
//                                       X-AgentX-Channel + X-AgentX-Chat: a
//                                       running turn of that agent asks for
//                                       the newest frame. 200 {frame: {path,
//                                       width, height, takenAt}}; 403 no such
//                                       running turn; 404 no live share for it
//
// All of it is mesh-gated (isMeshGatedPath): a look runs an agent's turn,
// and a snapshot writes a picture of the owner's surroundings to disk.

import { defaultSession, type CameraWatchManager, type TurnSession } from "@/camera/watch"
import type { CallerProof, CallService } from "@/calls/service"
import type { Reply } from "@/daemon/voice-talk-api"

export interface CameraApiDeps {
  watch: CameraWatchManager
  /** True when `proof` names a running turn of `agentId`. */
  isRunningTurn: (agentId: string, proof: CallerProof) => boolean
  /** Camera asks (phase 3), when this node has SQLite. */
  calls?: Pick<CallService, "get">
}

export function isCameraPath(path: string): boolean {
  return path === "/webrtc/camera" || path.startsWith("/webrtc/camera/")
}

export async function handleCamera(
  deps: CameraApiDeps,
  method: string,
  path: string,
  body: Record<string, unknown>,
  proof: CallerProof = {},
): Promise<Reply> {
  const { watch } = deps

  if (path === "/webrtc/camera/watch") {
    if (method === "GET") return { status: 200, body: { active: watch.active() } }
    if (method !== "POST") return { status: 405, body: { error: "GET or POST" } }
    const callId = String(body.callId ?? "")
    const agentId = String(body.agentId ?? "").trim()
    // A share that answers a camera ask carries the ask's id. The ask must
    // be answered (the owner's tap) and be this agent's, and the watch
    // runs where the agent asked from.
    let session: TurnSession | undefined
    let callRecordId: string | undefined
    const ask = deps.calls?.get(callId)
    if (ask) {
      if (ask.kind !== "camera") return { status: 409, body: { error: `${callId} is a voice call, not a camera ask` } }
      if (ask.agentId !== agentId) return { status: 403, body: { error: `${callId} was asked by ${ask.agentId}, not ${agentId || "(none)"}` } }
      if (ask.status !== "answered") return { status: 409, body: { error: `the owner has not accepted ${callId} (it is ${ask.status})` } }
      session = ask.channel && ask.chatId ? { channel: ask.channel, chatId: ask.chatId, sender: "Camera" } : defaultSession(agentId)
      callRecordId = ask.id
    }
    const r = await watch.start({ callId, agentId, session, callRecordId })
    return r.ok ? { status: 201, body: { watch: r.watch } } : { status: r.status, body: { error: r.error } }
  }

  if (path === "/webrtc/camera/look") {
    if (method !== "POST") return { status: 405, body: { error: "POST" } }
    const agentId = String(body.agentId ?? "").trim()
    if (!agentId) return { status: 400, body: { error: "Required: agentId" } }
    if (!deps.isRunningTurn(agentId, proof)) {
      return { status: 403, body: { error: `No running turn of ${agentId} asked for this frame. An agent looks from inside its own run.` } }
    }
    const r = watch.snapshot(agentId)
    return r.ok ? { status: 200, body: { frame: r.frame, callId: r.callId } } : { status: r.status, body: { error: r.error } }
  }

  // Share ids are plain ASCII (cam-…, call-…): no decoding needed.
  const [, , , , id, action, extra] = path.split("/")
  if (path.split("/")[3] !== "watch" || !id || extra !== undefined) return notFound
  if (action === undefined) {
    if (method !== "GET") return { status: 405, body: { error: "GET" } }
    const view = watch.get(id)
    return view ? { status: 200, body: { watch: view } } : { status: 404, body: { error: `No agent is watching share ${id}` } }
  }
  if (method !== "POST") return { status: 405, body: { error: "POST" } }
  switch (action) {
    case "look": {
      const r = await watch.look(id, body.note)
      if (!r.ok) return { status: r.status, body: { error: r.error } }
      // The owner sees the answer; the file's path is the agent's business.
      const { width, height, takenAt, seq } = r.frame
      return { status: 200, body: { reply: r.reply, frame: { width, height, takenAt, seq } } }
    }
    case "stream": {
      const r = watch.stream(id, body.seconds, body.note)
      return r.ok ? { status: 200, body: { watch: r.watch } } : { status: r.status, body: { error: r.error } }
    }
    case "stop":
      return watch.stop(id, "stopped by the owner")
        ? { status: 200, body: { ok: true } }
        : { status: 404, body: { error: `No agent is watching share ${id}` } }
    default:
      return notFound
  }
}

const notFound: Reply = { status: 404, body: { error: "Not found" } }
