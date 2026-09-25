// Agent presence on the daemon's screen: the per-turn presence-mode
// decision, live lessons, and the agent's cursor during a spoken answer.
// See src/decisions/seats/presence-mode.ts and src/voice/live-teach.ts.

import { execFile } from "child_process"
import { promisify } from "util"
import type { DaemonConfig } from "@/daemon/config"
import { askSeat, getSeatMode } from "@/decisions/seat"
import {
  PRESENCE_MODE_SEAT, presenceModeQuestions, presenceModeState, toPresence,
  type PresenceDecision, type PresenceMode, type PresenceModeAnswers,
} from "@/decisions/seats/presence-mode"
import { HELPER } from "@/computer-use/screen"
import { LiveTeach, teachSystemPrompt, type TeachDeps, type TeachMode } from "@/voice/live-teach"
import { helperAct, readScreenView } from "@/voice/live-teach-screen"
import { IDLE_SECONDS, PresenceOverlay, presenceLook, reapPresence, type Presence, type PresenceLook } from "@/voice/presence"
import type { SpeechOut } from "@/voice/speaker"
import type { LineModel } from "@/voice/talk-model"
import { talkSpeaker, type VoiceSettings } from "@/voice/agent-voice"

const run = promisify(execFile)
/** Budget for the per-turn decision; Jev answers in about half a second. */
const DECIDE_MS = 2_500
/** A presence kept after its turn (persist) still goes after this long. */
export const PERSIST_MS = 5 * 60 * 1000
/** Held overlays are pinged this often, well inside the helper's idle timeout. */
const PING_MS = (IDLE_SECONDS * 1000) / 3
type Agents = DaemonConfig["agents"]

/** The one overlay an agent has on screen, and what it is doing. */
interface Slot {
  presence: Presence
  use: "talk" | "lesson"
  timer?: NodeJS.Timeout
  ping: NodeJS.Timeout
}

export interface PresenceHostDeps {
  /** The global voice settings (agentx.json `voice`). */
  voiceSettings?: () => VoiceSettings
  overlay?: (look: PresenceLook, agentId: string) => Presence
  screen?: Pick<TeachDeps, "readScreen" | "act">
  frontmostApp?: () => Promise<string | null>
}

export interface PresenceTurn extends PresenceDecision {
  /** off: no seat, talk as before. shadow: logged only. active: acted on. */
  seat: "off" | "shadow" | "active"
}

async function helperFrontmostApp(): Promise<string | null> {
  try {
    const { stdout } = await run(HELPER, ["focused"], { timeout: 1500 })
    return (JSON.parse(stdout).app as string) || null
  } catch {
    return null
  }
}

export class PresenceHost {
  /** At most one overlay per agent; lessons and spoken answers share it. */
  private slots = new Map<string, Slot>()
  private lastMode = new Map<string, PresenceMode>()
  /** The app in front when the agent was last asked: a lesson it starts
   *  is about that app, and stays on it. */
  private lastApp = new Map<string, string | null>()

  constructor(
    private agents: () => Agents,
    private log: (msg: string) => void,
    private deps: PresenceHostDeps = {},
  ) {}

  /** The presence-mode decision for one voice turn. Never throws; with the
   *  seat off or unsure, the answer is talk. */
  async decide(agentId: string, request: string): Promise<PresenceTurn> {
    const seat = getSeatMode(PRESENCE_MODE_SEAT)
    const look = presenceLook(agentId, this.agents()[agentId])
    if (seat === "off") return { ...toPresence(null, look.allowActions), seat }
    const app = await (this.deps.frontmostApp ?? helperFrontmostApp)()
    // It runs before the agent's turn, so it gets a hard budget: past it,
    // the turn goes ahead as talk rather than waiting on a slow backend.
    const ac = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const result = await Promise.race([
      askSeat(
        PRESENCE_MODE_SEAT,
        presenceModeState({ agent: agentId, request, app, actionsAllowed: look.allowActions, previousMode: this.lastMode.get(agentId) ?? null }),
        presenceModeQuestions,
        { timeoutMs: DECIDE_MS, signal: ac.signal, incumbent: { mode: "talk" }, features: { agent: agentId, app: app ?? "none" } },
      ),
      new Promise<null>((r) => { timer = setTimeout(() => { ac.abort(); r(null) }, DECIDE_MS) }),
    ]).finally(() => clearTimeout(timer))
    const decision = toPresence((result?.answers as PresenceModeAnswers) ?? null, look.allowActions)
    this.lastMode.set(agentId, decision.mode)
    this.lastApp.set(agentId, app)
    this.log(`[presence] ${agentId} seat=${seat} chose=${decision.chose ?? "-"} p=${decision.probability.toFixed(2)} → ${decision.mode}` +
      ` next=${decision.nextAction}${decision.persist ? " persist" : ""}${decision.override ? ` (${decision.override})` : ""}`)
    return { ...decision, seat }
  }

  /** A live lesson on this screen, in the agent's voice and cursor. */
  lesson(agentId: string, goal: string, mode: TeachMode, speech: SpeechOut, model: (system: string) => LineModel): LiveTeach {
    const agents = this.agents()
    const speaker = talkSpeaker(agentId, agents, false, this.deps.voiceSettings?.())
    const look = presenceLook(agentId, agents[agentId])
    const slot = this.acquire(agentId, "lesson")
    // The lesson ends by closing its presence: that releases the slot,
    // unless a newer turn has already taken it over.
    const presence: Presence = {
      moveTo: (r, o) => slot.presence.moveTo(r, o),
      say: (t) => slot.presence.say(t),
      clear: () => slot.presence.clear(),
      park: () => slot.presence.park(),
      close: () => { if (this.slots.get(agentId) === slot && slot.use === "lesson") this.hide(agentId) },
    }
    return new LiveTeach(
      { goal, mode, speaker, actionsAllowed: look.allowActions, app: this.lastApp.get(agentId) ?? undefined },
      {
        readScreen: this.deps.screen?.readScreen ?? readScreenView,
        act: this.deps.screen?.act ?? helperAct,
        presence,
        speech,
        model: model(teachSystemPrompt(speaker.persona, "Anis")),
      },
    )
  }

  /** The agent's cursor, parked, with its spoken answer in the bubble.
   *  Gone once the answer has had time to be heard; with persist it stays,
   *  quiet, until the next turn or PERSIST_MS. */
  showTalk(agentId: string, text: string, persist: boolean): void {
    const slot = this.acquire(agentId, "talk")
    slot.presence.park()
    slot.presence.say(text.length > 220 ? `${text.slice(0, 217)}…` : text)
    const heard = 2_000 + text.split(/\s+/).length * 400
    slot.timer = setTimeout(() => {
      if (!persist) return this.hide(agentId)
      slot.presence.say("")
      slot.timer = setTimeout(() => this.hide(agentId), PERSIST_MS)
    }, heard)
  }

  /** Fade the agent's overlay out; the helper process exits. */
  hide(agentId: string): void {
    const slot = this.slots.get(agentId)
    if (!slot) return
    clearTimeout(slot.timer)
    clearInterval(slot.ping)
    slot.presence.close()
    this.slots.delete(agentId)
  }

  close(): void {
    for (const id of [...this.slots.keys()]) this.hide(id)
  }

  /** The door opened: empty every spoken-answer bubble (lessons hush themselves). */
  quiet(): void {
    for (const slot of this.slots.values()) if (slot.use === "talk") slot.presence.say("")
  }

  /** Agents with an overlay on screen right now. */
  get onScreen(): string[] { return [...this.slots.keys()] }

  /** On daemon start: end overlays left by an earlier daemon or a dead parent. */
  reapOrphans(): void {
    const n = reapPresence()
    if (n) this.log(`[presence] ended ${n} leftover overlay${n === 1 ? "" : "s"}`)
  }

  /** The agent's overlay: the one already on screen, or a new one. Never a second. */
  private acquire(agentId: string, use: Slot["use"]): Slot {
    const cur = this.slots.get(agentId)
    // Its helper may have exited on its own (idle, crash): draw afresh.
    if (cur && cur.presence.alive === false) this.hide(agentId)
    else if (cur) {
      clearTimeout(cur.timer)
      cur.timer = undefined
      cur.use = use
      return cur
    }
    const presence = this.overlay(presenceLook(agentId, this.agents()[agentId]), agentId)
    const ping = setInterval(() => presence.ping?.(), PING_MS)
    ping.unref?.()
    const slot: Slot = { presence, use, ping }
    this.slots.set(agentId, slot)
    return slot
  }

  private overlay(look: PresenceLook, agentId: string): Presence {
    return this.deps.overlay?.(look, agentId) ?? new PresenceOverlay(look, HELPER, agentId)
  }
}
