import type { IncomingMessage, ServerResponse } from "http"
import type { DeskBoard } from "@/desk/board"
import { readJson, type NodeReply } from "./app-fleet"

// --- Phone app: the Desk tab (/api/app/desk*) (#959) ---
//
// Runs behind the device-token check in app-routes.ts, so every handler
// here may assume a paired phone: the owner's.
//
//   GET  /api/app/desk         the board (desk/board.ts), read from its
//                              sources at this moment
//   POST /api/app/desk/reply   { id, text }: a written answer on one of
//                              this node's requests. Its agent gets the
//                              text and goes on.
//
// Yes, no, a choice and "later" are the inbox's own answers and go through
// POST /api/app/approvals/decide (app-fleet.ts).

export const DESK_REPLY_MAX = 4000

export interface AppDeskDeps {
  board(): Promise<DeskBoard>
  reply(id: string, text: string): Promise<NodeReply>
}

/** Handles /api/app/desk*. Returns false for any other path. */
export async function handleAppDesk(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  deps: AppDeskDeps,
): Promise<boolean> {
  if (method === "GET" && path === "/api/app/desk") return json(res, 200, await deps.board())
  if (method !== "POST" || path !== "/api/app/desk/reply") return false

  let body: Record<string, unknown>
  try { body = await readJson(req) } catch (e: any) { return json(res, 400, { error: e.message }) }
  const id = typeof body.id === "string" ? body.id.trim() : ""
  const text = typeof body.text === "string" ? body.text.trim() : ""
  if (!id || !text) return json(res, 400, { error: "id and text are required" })
  if (text.length > DESK_REPLY_MAX) return json(res, 400, { error: `the answer is longer than ${DESK_REPLY_MAX} characters` })
  const reply = await deps.reply(id, text)
  return json(res, reply.status, reply.body)
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
  res.end(JSON.stringify(body))
  return true
}
