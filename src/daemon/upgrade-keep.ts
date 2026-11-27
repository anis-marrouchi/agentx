import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici"
import type { Reply } from "@/daemon/voice-talk-api"
import type { VoiceRequest, VoiceRequestStore } from "@/daemon/voice-requests-api"

// --- A widget message during an upgrade is kept, not refused (#2502) ---
//
// While the daemon drains for a restart, /ask is new work and is refused
// (shutdown.ts). A widget message carries its open-requests row, so instead
// of a 503 the row is kept (held "upgrade") and the widget hears at once
// that AgentX is upgrading. The next daemon runs every kept row once, oldest
// first, before it takes new widget rows. Counts go to last.json through
// the upgrade job, like the admission queue's (upgrade-queue-record.ts).

export const WIDGET_KEEP_FILE = "widget-keep.json"

/** The words the widget says when its message is kept. */
export function upgradingText(msLeft: number): string {
  // The rest of the drain, then about a minute for the new daemon to start.
  const n = Math.max(1, Math.ceil((Math.max(0, msLeft) + 60_000) / 60_000))
  return `AgentX is upgrading, back in about ${n} minute${n === 1 ? "" : "s"}. Your message is kept.`
}

/** The reply to a POST /ask that came during the drain, or null when it
 *  has no open row to keep it in (the caller then answers 503). */
export function keepAskForUpgrade(input: {
  store: VoiceRequestStore | null
  body: Record<string, unknown>
  msLeft: number
  now?: number
}): Reply | null {
  const { store, body } = input
  const id = typeof body.request === "string" ? body.request : ""
  if (!store || !id) return null
  const session = typeof body.session === "string" && body.session.trim() ? body.session.trim() : null
  if (!store.keepForUpgrade(id, session, input.now)) return null
  const row = store.get(id)!
  const text = upgradingText(input.msLeft)
  return {
    status: 202,
    body: { agentId: row.agentId, voice: null, presence: null, text, full: text, ui: null, kept: true, request: id },
  }
}

/** The drain gate's POST /ask: the mesh check comes first (#2502 B3).
 *  /ask is mesh-protected, and a kept row is later sent by the next daemon
 *  over loopback, where it is never checked again. "refused" means
 *  `authorized` has already answered (401/403); null means answer 503. */
export async function drainAsk(input: {
  authorized: () => boolean
  readBody: () => Promise<Record<string, unknown>>
  keep: (body: Record<string, unknown>) => Reply | null
}): Promise<Reply | "refused" | null> {
  if (!input.authorized()) return "refused"
  return input.keep(await input.readBody())
}

/** Run each kept row once, oldest first. `ask` sends it as the widget
 *  would (POST /ask with its row), calls `sent()` once /ask has taken the
 *  row, and resolves when /ask has answered. The next row starts once the
 *  one before it is sent (or its send ended), not answered, and the
 *  returned promise resolves when every row has started (#2502 B1): one
 *  slow kept run does not hold the rows behind it.
 *  The row stops being "kept" before its run starts, so a daemon that
 *  dies mid-run fails it at the next boot instead of running it twice. */
export async function replayKept(input: {
  store: VoiceRequestStore
  ask: (row: VoiceRequest & { session: string | null }, sent: () => void) => Promise<void>
  log: (line: string) => void
}): Promise<number> {
  const rows = input.store.keptForUpgrade()
  for (const row of rows) {
    input.store.started(row.id)
    let sent!: () => void
    const taken = new Promise<void>((r) => { sent = r })
    const run = input.ask(row, sent).then(
      () => input.log(`[upgrade-keep] replayed ${row.id} to ${row.agentId}`),
      (err) => {
        input.store.settle(row.id, 500, { error: `Kept during an AgentX upgrade, but sending it failed: ${(err as Error).message}` })
        input.log(`[upgrade-keep] replay of ${row.id} failed: ${(err as Error).message}`)
      },
    )
    await Promise.race([taken, run])
  }
  return rows.length
}

// Node's fetch gives up on headers after 300 s, and a kept run can be
// longer: the replay's own /ask has no header or body time limit (#2502 B2).
const replayDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

/** POST one kept row to this daemon's /ask and read the whole answer. */
export async function postKeptAsk(url: string, headers: Record<string, string>, body: unknown, dispatcher: Dispatcher = replayDispatcher): Promise<void> {
  const res = await undiciFetch(url, { method: "POST", headers, body: JSON.stringify(body), dispatcher })
  await res.text()
}

export interface WidgetKeep {
  /** When the old daemon kept its first message, or the new one booted. */
  at: string
  /** Widget messages the old daemon kept during the drain. */
  kept?: number
  /** Kept messages the new daemon found to send at boot. */
  replayed?: number
}

function keepPath(agentxDir: string): string {
  return resolve(agentxDir, "upgrade", WIDGET_KEEP_FILE)
}

export function readWidgetKeep(agentxDir: string, sinceIso: string): WidgetKeep | null {
  const path = keepPath(agentxDir)
  if (!existsSync(path)) return null
  try {
    const rec = JSON.parse(readFileSync(path, "utf-8")) as WidgetKeep
    return Date.parse(rec.at) >= Date.parse(sinceIso) ? rec : null
  } catch {
    return null
  }
}

/** Merge `patch` into the record. The old daemon writes `kept` (one more
 *  each time); the new one adds `replayed`. A record from an earlier
 *  upgrade (older than `sinceIso`) is replaced, not added to. */
export function writeWidgetKeep(agentxDir: string, sinceIso: string, patch: { kept?: number; replayed?: number }, now = new Date()): WidgetKeep {
  const prev = readWidgetKeep(agentxDir, sinceIso)
  const rec: WidgetKeep = { at: prev?.at ?? now.toISOString() }
  const kept = (prev?.kept ?? 0) + (patch.kept ?? 0)
  if (kept || prev?.kept !== undefined) rec.kept = kept
  if (patch.replayed !== undefined) rec.replayed = patch.replayed
  else if (prev?.replayed !== undefined) rec.replayed = prev.replayed
  mkdirSync(resolve(agentxDir, "upgrade"), { recursive: true })
  writeFileSync(keepPath(agentxDir), JSON.stringify(rec) + "\n")
  return rec
}
