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
import { PresenceOverlay, presenceLook, type Presence, type PresenceLook } from "@/voice/presence"
import type { SpeechOut } from "@/voice/speaker"
import type { LineModel } from "@/voice/talk-model"
import { talkSpeaker } from "@/voice/agent-voice"

const run = promisify(execFile)
/** Budget for the per-turn decision; Jev answers in about half a second. */
const DECIDE_MS = 2_500
type Agents = DaemonConfig["agents"]

export interface PresenceHostDeps {
  overlay?: (look: PresenceLook) => Presence
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
  private shown = new Map<string, { presence: Presence; timer?: NodeJS.Timeout }>()
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
    const speaker = talkSpeaker(agentId, agents, false)
    const look = presenceLook(agentId, agents[agentId])
    this.hide(agentId)
    return new LiveTeach(
      { goal, mode, speaker, actionsAllowed: look.allowActions, app: this.lastApp.get(agentId) ?? undefined },
      {
        readScreen: this.deps.screen?.readScreen ?? readScreenView,
        act: this.deps.screen?.act ?? helperAct,
        presence: this.overlay(look),
        speech,
        model: model(teachSystemPrompt(speaker.persona, "Anis")),
      },
    )
  }

  /** The agent's cursor, parked, with its spoken answer in the bubble.
   *  Gone once the answer has had time to be heard, unless it persists. */
  showTalk(agentId: string, text: string, persist: boolean): void {
    const look = presenceLook(agentId, this.agents()[agentId])
    const cur = this.shown.get(agentId) ?? { presence: this.overlay(look) }
    if (cur.timer) clearTimeout(cur.timer)
    cur.presence.park()
    cur.presence.say(text.length > 220 ? `${text.slice(0, 217)}…` : text)
    const words = text.split(/\s+/).length
    cur.timer = setTimeout(() => (persist ? cur.presence.say("") : this.hide(agentId)), 2_000 + words * 400)
    this.shown.set(agentId, cur)
  }

  hide(agentId: string): void {
    const cur = this.shown.get(agentId)
    if (cur?.timer) clearTimeout(cur.timer)
    cur?.presence.close()
    this.shown.delete(agentId)
  }

  close(): void {
    for (const id of [...this.shown.keys()]) this.hide(id)
  }

  private overlay(look: PresenceLook): Presence {
    return this.deps.overlay?.(look) ?? new PresenceOverlay(look, HELPER)
  }
}
