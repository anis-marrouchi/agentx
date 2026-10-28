import { readFileSync, statSync } from "fs"
import { resolve } from "path"
import { callerHeaders } from "@/calls/service"
import { AGENT_PICTURE_PATH, PICTURE_MAX_BYTES, PictureError, sniffPicture } from "./pictures"

// --- An agent sets its own picture (#1425) ---
//
// Shared by `agentx agent picture set|remove` run from an agent's shell and
// the agentx_picture tool. The daemon does the check that counts: the run
// this call names must be a running turn of the agent whose picture
// changes (AGENT_PICTURE_PATH in daemon/index.ts). The checks here only
// give a clear answer before a file is sent.

export interface SelfPictureDeps {
  daemonUrl: string
  /** The agent this run is for: AGENTX_AGENT_ID. */
  agentId?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  cwd?: string
}

export type SelfPictureResult = { ok: true; message: string } | { ok: false; message: string }

/** Read and check a file the way an upload is checked, before sending it. */
export function readPictureFile(file: string, cwd = process.cwd()): Buffer {
  const path = resolve(cwd, file)
  let size: number
  try { size = statSync(path).size } catch { throw new PictureError(`No file at ${path}.`) }
  if (size > PICTURE_MAX_BYTES) throw new PictureError(`The picture is ${(size / (1024 * 1024)).toFixed(1)} MB; the limit is 1 MB. Make it smaller and try again.`, 413)
  const bytes = readFileSync(path)
  sniffPicture(bytes)
  return bytes
}

/** Set (`file` given) or remove (`file` null) the calling agent's own picture. */
export async function setOwnPicture(file: string | null, target: string | undefined, deps: SelfPictureDeps): Promise<SelfPictureResult> {
  const env = deps.env ?? process.env
  const me = deps.agentId ?? env.AGENTX_AGENT_ID?.trim()
  if (!me) return { ok: false, message: "This is not an agent's run (AGENTX_AGENT_ID is not set)." }
  if (target && target !== me) {
    return { ok: false, message: `An agent can only change its own picture: you are "${me}", not "${target}". Ask the owner to change it in Settings.` }
  }
  const proof = callerHeaders(env)
  if (!Object.keys(proof).length) {
    return { ok: false, message: "This run carries no proof of who you are (AGENTX_TASK_ID, or AGENTX_CHANNEL and AGENTX_CHAT_ID). Ask the owner to set the picture in Settings." }
  }
  let body: Buffer | undefined
  if (file !== null) {
    try { body = readPictureFile(file, deps.cwd) } catch (e: any) { return { ok: false, message: e.message } }
  }
  const url = `${deps.daemonUrl.replace(/\/+$/, "")}${AGENT_PICTURE_PATH}?agent=${encodeURIComponent(me)}`
  try {
    const res = await (deps.fetch ?? fetch)(url, {
      method: body ? "PUT" : "DELETE",
      headers: { ...proof, ...(body ? { "Content-Type": "application/octet-stream" } : {}) },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => ({})) as any
    if (!res.ok) return { ok: false, message: data?.error || `HTTP ${res.status}` }
    if (!body) return { ok: true, message: data.removed ? "Your picture is removed; your initials show again." : "You had no picture; nothing changed." }
    return { ok: true, message: "Your picture is set. It shows on the Wall, the Org page and Settings on their next load." }
  } catch (e: any) {
    return { ok: false, message: `Couldn't reach the daemon at ${deps.daemonUrl} (${e?.message ?? e}).` }
  }
}
