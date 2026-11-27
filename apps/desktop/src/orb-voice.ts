// The orb's talk loop, on the app side (#2265 PR 3). The orb page records
// and plays; this side talks to the dashboard, as the Hub chat does:
//
//   POST /api/assistant/voice/transcribe  a recording (rolling or final), written down
//   POST /api/assistant                   the words, as a spoken Hub chat message
//   GET  /api/assistant/thread            the answer, read until it is done
//   POST /api/assistant/voice/speak       the answer, said in the agent's voice
//
// These routes are the owner's alone. On this machine the dashboard gives its
// pages the owner's token (window.AX_LOCAL_TOKEN); the app reads it from the
// /hub page the same way its window does and keeps it in memory only. No
// audio, words or token are logged.

import { ipcMain, type IpcMainEvent } from "electron"
import { answerOf, caption, opening, MIN_TALK_MS, pageTokenOf, pickAgent, type AgentLike, type ThreadMessage } from "./orb-flow.js"
import type { OrbView } from "./orb-preload.js"

export interface OrbVoiceOptions {
  base: string
  /** The daemon's address: its /health names the node's default agent. */
  daemonUrl: string
  /** The chosen agent's id, "" for the node's first. */
  agent: () => string
  isOrb: (e: IpcMainEvent) => boolean
  show: (view: OrbView) => void
  /** Sends a message to the orb page. */
  send: (channel: string, ...args: unknown[]) => void
  log: (message: string, err?: unknown) => void
}

const POLL_MS = 1_500
const ANSWER_LIMIT_MS = 10 * 60_000
const NOTE_MS = 6_000

let o: OrbVoiceOptions
let token: string | null = null
let thread: { id: string; node?: string; agent: string } | null = null
let partialBusy = false
// Each turn has a number; a newer press (or a stop) makes older work drop its result.
let turn = 0
let noteTimer: NodeJS.Timeout | null = null

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  if (token === null) {
    try {
      const r = await fetch(`${o.base}/hub`)
      token = r.ok ? pageTokenOf(await r.text()) : ""
    } catch {
      return extra // the dashboard is down; try again next time
    }
  }
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra
}

async function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {}): Promise<Response> {
  let r = await fetch(o.base + path, { ...init, headers: await authHeaders(init.headers) })
  if (r.status === 401 && token !== null) {
    token = null // rotated: read it again once
    r = await fetch(o.base + path, { ...init, headers: await authHeaders(init.headers) })
  }
  return r
}

async function errorOf(r: Response): Promise<string> {
  const d = (await r.json().catch(() => ({}))) as { error?: string; hint?: string }
  if (r.status === 401) return "The dashboard did not accept this app. Open the Hub once, then try again."
  return [d.error, d.hint].filter(Boolean).join(" ") || `HTTP ${r.status}`
}

async function transcribe(bytes: ArrayBuffer, type: string, ms: number): Promise<string> {
  const r = await call("/api/assistant/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": type.split(";")[0] || "audio/webm", "X-Audio-Duration-Ms": String(Math.round(ms)) },
    body: Buffer.from(bytes),
  })
  if (!r.ok) throw new Error(await errorOf(r))
  const d = (await r.json()) as { text?: string }
  return String(d.text || "").trim()
}

/** A short note on the pill, then back to rest. */
function note(title: string, text = ""): void {
  o.show({ state: "idle", title, text })
  if (noteTimer) clearTimeout(noteTimer)
  noteTimer = setTimeout(() => o.show({ state: "idle" }), NOTE_MS)
}

async function agentNow(): Promise<{ id: string; name: string } | null> {
  const r = await call("/api/agents")
  if (!r.ok) throw new Error(await errorOf(r))
  const d = (await r.json()) as AgentLike[] | { agents?: AgentLike[] }
  return pickAgent(Array.isArray(d) ? d : d.agents || [], o.agent(), await nodeDefault())
}

/** The daemon's node.defaultAgent, "" when it names none or does not answer. */
export async function nodeDefault(): Promise<string> {
  try {
    const r = await fetch(`${o.daemonUrl}/health`)
    const d = (await r.json()) as { node?: { defaultAgent?: unknown } }
    return typeof d.node?.defaultAgent === "string" ? d.node.defaultAgent : ""
  } catch {
    return ""
  }
}

/** The node's agents, for the tray's "Orb talks to"; empty when the dashboard does not answer. */
export async function orbAgents(): Promise<{ id: string; name: string }[]> {
  try {
    const r = await call("/api/agents")
    if (!r.ok) return []
    const d = (await r.json()) as AgentLike[] | { agents?: AgentLike[] }
    return (Array.isArray(d) ? d : d.agents || [])
      .map((a) => ({ id: a.id || a.name || "", name: a.name || a.id || "" }))
      .filter((a) => a.id)
  } catch {
    return []
  }
}

async function readThread(): Promise<ThreadMessage[]> {
  if (!thread) return []
  const at = thread.node ? `&node=${encodeURIComponent(thread.node)}` : ""
  const r = await call(`/api/assistant/thread?id=${encodeURIComponent(thread.id)}${at}`)
  if (r.status === 404) return []
  if (!r.ok) throw new Error(await errorOf(r))
  return ((await r.json()) as { messages?: ThreadMessage[] }).messages || []
}

async function finalTake(bytes: ArrayBuffer, type: string, ms: number): Promise<void> {
  const mine = ++turn
  const live = (): boolean => mine === turn
  if (ms < MIN_TALK_MS) return note("Hold the orb while you speak, then let go.")
  o.show({ state: "thinking", text: "Writing it down…" })
  try {
    const words = await transcribe(bytes, type, ms)
    if (!live()) return
    if (!words) return note("Nothing was heard.", "Try again a little closer to the microphone.")
    const agent = await agentNow()
    if (!live()) return
    if (!agent) return note("No agent to talk to.", "Add an agent on this node first.")
    // The same conversation while the orb talks to the same agent.
    if (thread && thread.agent !== agent.id) thread = null
    const before = (await readThread()).length
    o.show({ state: "thinking", title: agent.name, text: caption(words) })
    const r = await call("/api/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: thread?.id, agentId: agent.id, node: thread?.node, message: words, spoken: true }),
    })
    if (!r.ok) throw new Error(await errorOf(r))
    const d = (await r.json()) as { threadId?: string; node?: string; error?: string }
    if (d.error || !d.threadId) throw new Error(d.error || "The node gave no conversation.")
    thread = { id: d.threadId, node: d.node || thread?.node, agent: agent.id }
    await answer(agent.name, before, live)
  } catch (err) {
    if (live()) note("Not sent", err instanceof Error ? err.message : String(err))
  }
}

async function answer(name: string, before: number, live: () => boolean): Promise<void> {
  const t0 = Date.now()
  while (live() && Date.now() - t0 < ANSWER_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (!live()) return
    const a = answerOf(await readThread(), before + 1)
    if (a.kind === "failed") return note(`${name} could not answer`, caption(a.why))
    if (a.kind === "working") {
      // The agent's words as they come, while it works.
      if (a.partial) o.show({ state: "thinking", title: name, text: caption(a.partial) })
      continue
    }
    return speak(name, a.text, live)
  }
  if (live()) note(`${name} is still working`, "The answer will be in the Hub.")
}

async function speak(name: string, text: string, live: () => boolean): Promise<void> {
  o.show({ state: "speaking", title: name, text: opening(text) })
  const r = await call("/api/assistant/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId: thread?.id, node: thread?.node, text: text.slice(0, 8000) }),
  })
  if (!live()) return
  const type = r.headers.get("content-type") || ""
  if (r.ok && type.startsWith("audio/")) {
    o.send("orb:play", { audio: await r.arrayBuffer(), type, text })
    return
  }
  const d = (await r.json().catch(() => ({}))) as { fallback?: string; text?: string }
  // No voice on the node: the system's own voice says it (orb page).
  o.send("orb:play", { text: d.text || text, system: true })
}

export function setupOrbVoice(opts: OrbVoiceOptions): void {
  o = opts
  // A rolling pass (C11): the page asks at most one at a time; one in flight here drops the next.
  ipcMain.on("orb:partial", (e, bytes: unknown, type: unknown, ms: unknown) => {
    if (!o.isOrb(e) || partialBusy || !(bytes instanceof ArrayBuffer) || typeof type !== "string" || !Number.isFinite(ms)) return
    partialBusy = true
    const mine = turn
    transcribe(bytes, type, ms as number)
      .then((text) => {
        if (mine === turn) o.send("orb:partial", caption(text))
      })
      .catch(() => o.send("orb:partial", null)) // a failed pass: the page keeps the meter
      .finally(() => {
        partialBusy = false
      })
  })
  ipcMain.on("orb:final", (e, bytes: unknown, type: unknown, ms: unknown) => {
    if (!o.isOrb(e) || !(bytes instanceof ArrayBuffer) || typeof type !== "string" || !Number.isFinite(ms)) return
    void finalTake(bytes, type, ms as number)
  })
  // The person pressed again, or tapped the orb to stop: older work drops its result.
  ipcMain.on("orb:cancel", (e) => {
    if (!o.isOrb(e)) return
    turn++
    o.show({ state: "idle" })
  })
  // A new recording: whatever the orb was doing for the last one stops.
  ipcMain.on("orb:begin", (e) => {
    if (o.isOrb(e)) turn++
  })
  ipcMain.on("orb:played", (e) => {
    if (o.isOrb(e)) o.show({ state: "idle" })
  })
}
