// The floor over HTTP (see src/voice/floor.ts): one holder at a time may
// speak and show a bubble on this host. A script, a demo or a recording
// takes it, and everything else waits until it is free (#924).
//
//   GET    /voice/floor              {held, holder, sound, hide, expiresAt, …}
//                                    ?after=<seq> waits for the next change,
//                                    or 25 s.
//   POST   /voice/floor              {holder, seconds?, sound?, hide?, pid?,
//                                    agentId?}  take it. 201 {id, …}: the id
//                                    is the holder's proof. 409 when someone
//                                    else holds it, with who.
//                                    sound: the holder plays sound of its own.
//                                    hide: a recording; the character and
//                                    every bubble stay hidden.
//                                    pid: freed when that process is gone.
//                                    id: take the free floor again under the
//                                    id of a hold a daemon restart forgot.
//   POST   /voice/floor/:id/renew    {seconds?}  keep it that long from now.
//                                    410 once it is no longer :id's: the
//                                    holder stops.
//   GET    /voice/floor/:id          200 while it is still :id's, else 410.
//   POST   /voice/floor/:id/release  let go. DELETE /voice/floor/:id too.
//   DELETE /voice/floor              the owner takes it back, whoever holds
//                                    it. /voice/stop (the stop hotkey) does too.
//
// A holder speaks through the queue with its id (POST /voice/queue
// {floor}) and moves the character with it (POST /voice/guide {floor}).
// Same gate as /ask.

import type { Floor } from "@/voice/floor"
import type { Reply } from "@/daemon/voice-talk-api"

export function isFloorPath(path: string): boolean {
  return path === "/voice/floor" || path.startsWith("/voice/floor/")
}

const num = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : Number(v))

export async function handleFloor(
  floor: Floor,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown>,
  /** The caller hung up: ends its wait. */
  gone?: AbortSignal,
): Promise<Reply> {
  if (path === "/voice/floor") {
    if (method === "GET") {
      const after = query.get("after")
      return { status: 200, body: after === null ? floor.view() : await floor.next(Number(after) || 0, undefined, gone) }
    }
    if (method === "DELETE") return { status: 200, body: { revoked: floor.revoke(), ...floor.view() } }
    if (method !== "POST") return { status: 405, body: { error: "GET, POST or DELETE" } }
    const took = floor.take({
      holder: typeof body.holder === "string" ? body.holder : "",
      agentId: typeof body.agentId === "string" ? body.agentId : null,
      seconds: num(body.seconds),
      sound: body.sound === true,
      hide: body.hide === true,
      pid: num(body.pid) ?? null,
      ...(typeof body.id === "string" ? { id: body.id } : {}),
    })
    if (took.ok) return { status: 201, body: { id: took.id, ...took.view } }
    const status = took.reason === "invalid" ? 400 : took.reason === "off" ? 403 : 409
    return { status, body: { error: took.error, floor: took.view } }
  }

  // Ids are hex: no decoding needed.
  const [, , , id, action, extra] = path.split("/")
  if (!id || extra !== undefined) return { status: 404, body: { error: "Not found" } }
  if (method === "GET" && action === undefined) {
    return floor.holds(id) ? { status: 200, body: floor.view() } : { status: 410, body: { error: "The floor is no longer yours", floor: floor.view() } }
  }
  if ((method === "DELETE" && action === undefined) || (method === "POST" && action === "release")) {
    return { status: 200, body: { released: floor.release(id), ...floor.view() } }
  }
  if (method === "POST" && action === "renew") {
    const view = floor.renew(id, num(body.seconds))
    if (view) return { status: 200, body: view }
    if (floor.holds(id)) return { status: 400, body: { error: `seconds is up to ${floor.settings.maxSeconds}` } }
    return { status: 410, body: { error: "The floor is no longer yours", floor: floor.view() } }
  }
  return { status: 404, body: { error: "Not found" } }
}
