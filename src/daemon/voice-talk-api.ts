// Talk mode, live lessons and task narration on the daemon (see
// src/voice/talk.ts, live-teach.ts, narrator.ts). One voice session at a
// time — a talk or a lesson — since they share the host's speakers; the
// /talk/hush and /talk/door routes (Option-Space) reach whichever runs.
//
//   POST /talk        {agents: [a, b], topic, context?, maxTurns?}  start one;
//                     either agent may live on a mesh peer
//   GET  /talk        the active talk (or {active: false})
//   POST /voice/hush  the door (Option-Space): whatever is speaking stops —
//                     a talk, a lesson, narration, a spoken-answer bubble,
//                     AgentX Voice's own line — and queued lines are dropped.
//                     Returns what was speaking: {active, kind, agentId}.
//   POST /voice/stop  the same silence, for a hotkey, menu, Siri or a
//                     Shortcut; nothing is kept waiting for the door.
//   POST /voice/door  {text}  the listener spoke: a talk or lesson answers
//                     it first; "stop" ends it, or silences the narrated
//                     task. 409 when nothing takes the words (ask instead).
//   /talk/hush and /talk/door are the same routes, kept for older clients.
//   POST /talk/stop
//   POST /teach/live  {agent, goal, mode?: teach | watch | act, app?}  a live
//                     lesson on `app`, or on the app in front as it starts
//   GET  /narration   runtime switches
//   POST /narration   {agentId? | taskId?, on: true | false | null}
//
// Same gate as /ask: each of these makes the host speak.

import type { DaemonConfig } from "@/daemon/config"
import { Talk, isStop, type TalkSpeaker } from "@/voice/talk"
import { Narrator } from "@/voice/narrator"
import { SpeechOut, stopAllSpeakers } from "@/voice/speaker"
import { createLineModel, type LineModel } from "@/voice/talk-model"
import { resolveAgentVoice, talkSpeaker, voiceRef, type VoiceIntroTracker, type VoiceSettings } from "@/voice/agent-voice"
import { LiveTeach, type TeachMode } from "@/voice/live-teach"
import { PresenceHost, type PresenceHostDeps } from "@/daemon/voice-presence"

export { talkSpeaker }
import { NARRATOR_SYSTEM } from "@/voice/narrator"

type Agents = DaemonConfig["agents"]
export type Reply = { status: number; body: unknown }

/** Swapped in tests: no real model process, no real audio or screen. */
export interface VoiceTalkDeps {
  speech?: SpeechOut
  model?: (system: string) => LineModel
  presence?: PresenceHostDeps
  /** A talk participant from a mesh peer, when the id is not local. */
  remote?: (agentId: string, introduce: boolean) => TalkSpeaker | undefined
  /** The global voice settings (agentx.json `voice`), read per line so a
   *  change applies to the next one. */
  voiceSettings?: () => VoiceSettings
  /** Silence every speaker on the host, not only this daemon's. */
  stopSpeakers?: () => void
}

type VoiceSession = Talk | LiveTeach

export class VoiceTalkService {
  readonly speech: SpeechOut
  readonly narrator: Narrator
  readonly presence: PresenceHost
  private session: VoiceSession | null = null
  /** The narrated task the last hush silenced, until the listener speaks. */
  private hushed: { taskId: string; agentId: string } | null = null
  private model: (system: string) => LineModel
  private remote: NonNullable<VoiceTalkDeps["remote"]>
  private settings: () => VoiceSettings
  private stopSpeakers: () => void

  constructor(
    private agents: () => Agents,
    private intros: VoiceIntroTracker,
    private log: (msg: string) => void = () => {},
    deps: VoiceTalkDeps = {},
  ) {
    this.speech = deps.speech ?? new SpeechOut()
    this.model = deps.model ?? ((system) => createLineModel({ system }))
    this.remote = deps.remote ?? (() => undefined)
    this.stopSpeakers = deps.stopSpeakers ?? (() => stopAllSpeakers())
    const settings = deps.voiceSettings ?? (() => ({}))
    this.settings = settings
    this.presence = new PresenceHost(agents, log, { voiceSettings: settings, ...deps.presence })
    this.narrator = new Narrator({
      speech: this.speech,
      model: () => this.model(NARRATOR_SYSTEM),
      voiceOf: (id) => {
        const agent = this.agents()[id]
        if (!agent) return null
        const v = resolveAgentVoice(id, this.agents(), this.settings())
        return { name: v.name, voice: voiceRef(v), style: v.style, narrate: agent.voice?.narrate ?? "off" }
      },
    })
  }

  handle(method: string, path: string, body: Record<string, unknown>): Reply {
    const talk = this.live
    switch (`${method} ${path}`) {
      case "GET /talk":
        return { status: 200, body: talk ? this.view(talk) : { active: false } }
      case "POST /talk":
        return this.start(body)
      case "POST /teach/live": {
        const agentId = String(body.agent ?? body.agentId ?? "")
        const goal = String(body.goal ?? "").trim()
        const mode = String(body.mode ?? "teach") as TeachMode
        if (!goal || !["teach", "watch", "act"].includes(mode)) return { status: 400, body: { error: "Required: agent, goal, and mode teach | watch | act" } }
        if (!this.agents()[agentId]) return { status: 404, body: { error: `Unknown agent: ${agentId}` } }
        return this.startLesson(agentId, goal, mode, String(body.app ?? "").trim() || undefined)
      }
      case "POST /talk/hush":
      case "POST /voice/hush":
        return this.hush()
      case "POST /voice/stop": {
        const reply = this.hush()
        this.hushed = null
        return reply
      }
      case "POST /talk/door":
      case "POST /voice/door": {
        const text = String(body.text ?? "").trim()
        if (!text) return { status: 400, body: { error: "Required: text" } }
        return this.door(text)
      }
      case "POST /talk/stop":
        talk?.stop("stopped")
        return { status: 200, body: { active: false } }
      case "GET /narration":
        return { status: 200, body: this.narrator.status() }
      case "POST /narration": {
        const on = body.on === null ? null : body.on === true ? true : body.on === false ? false : undefined
        const agentId = body.agentId ? String(body.agentId) : undefined
        const taskId = body.taskId ? String(body.taskId) : undefined
        if (on === undefined || (!agentId && !taskId)) return { status: 400, body: { error: "Required: agentId or taskId, and on: true | false | null" } }
        if (agentId && !this.agents()[agentId]) return { status: 404, body: { error: `Unknown agent: ${agentId}` } }
        this.narrator.set({ agentId, taskId }, on)
        return { status: 200, body: this.narrator.status() }
      }
      default:
        return { status: 404, body: { error: "Not found" } }
    }
  }

  /** The door opens: everything this daemon is saying stops at once. */
  hush(): Reply {
    const live = this.live
    live?.hush()
    this.speech.stop()
    this.stopSpeakers()
    this.presence.quiet()
    const narrated = this.narrator.hush()
    this.hushed = live ? null : narrated
    const kind = live ? this.kind(live) : narrated ? "narration" : null
    const agentId = live ? this.agentOf(live) : narrated?.agentId ?? null
    this.log(`[door] hush → ${kind ? `${kind}${agentId ? ` (${agentId})` : ""}` : "nothing was speaking"}`)
    return { status: 200, body: { active: !!live, kind, agentId } }
  }

  /** What the listener said through the door. */
  door(text: string): Reply {
    const live = this.live
    const narrated = this.hushed
    this.hushed = null
    this.narrator.release()
    const quote = `"${text.slice(0, 80)}"`
    if (live) {
      live.door(text)
      this.log(`[door] ${quote} → ${this.kind(live)}${live.state === "ended" ? " (ended)" : ""}`)
      return { status: 200, body: { active: live.state !== "ended", kind: this.kind(live), handled: true } }
    }
    if (narrated && isStop(text)) {
      this.narrator.set({ taskId: narrated.taskId }, false)
      this.log(`[door] ${quote} → narration of ${narrated.taskId} off`)
      return { status: 200, body: { active: false, kind: "narration", handled: true } }
    }
    this.log(`[door] ${quote} → nothing to take it; the client asks the agent`)
    return { status: 409, body: { active: false, handled: false, error: "No talk or lesson is running" } }
  }

  close(): void {
    this.session?.stop("daemon stopping")
    this.narrator.close()
    this.presence.close()
  }

  /** The running talk or lesson, if any. */
  get live(): VoiceSession | null {
    return this.session && this.session.state !== "ended" ? this.session : null
  }

  /** Start a live lesson; used by POST /teach/live and by voice turns the
   *  presence-mode seat routes to teach, watch or act (with the turn's app). */
  startLesson(agentId: string, goal: string, mode: TeachMode, app?: string): Reply {
    if (this.live) return { status: 409, body: { error: "A talk or lesson is already running", ...this.view(this.live) } }
    const lesson = this.presence.lesson(agentId, goal, mode, this.speech, this.model, app)
    lesson.on((e) => {
      if (e.type === "step") this.log(`[teach] ${e.n}. ${e.action}${e.target ? ` "${e.target.slice(0, 60)}"` : ""}: ${e.say}`)
      else if (e.type === "acted" && e.error) this.log(`[teach] action refused: ${e.error}`)
      else if (e.type === "replanned") this.log(`[teach] replanning: ${e.reason}`)
      else if (e.type === "error") this.log(`[teach] error: ${e.error}`)
      else if (e.type === "end") this.log(`[teach] ended (${e.reason})`)
    })
    this.session = lesson
    void lesson.run()
    this.log(`[teach] ${agentId} (${mode}): ${goal.slice(0, 100)}`)
    return { status: 201, body: this.view(lesson) }
  }

  private start(body: Record<string, unknown>): Reply {
    if (this.live) return { status: 409, body: { error: "A talk or lesson is already running", ...this.view(this.live) } }
    const ids = Array.isArray(body.agents) ? body.agents.map(String) : []
    const topic = String(body.topic ?? "").trim()
    const agents = this.agents()
    if (ids.length !== 2 || ids[0] === ids[1] || !topic) return { status: 400, body: { error: "Required: agents (two different ids) and topic" } }
    // Either side may be a mesh agent: its persona comes from its agent
    // card and its voice is spoken here.
    const session = "talk"
    const speakerOf = (id: string) => {
      const introduce = this.intros.needsIntro(session, id)
      return agents[id] ? talkSpeaker(id, agents, introduce, this.settings()) : this.remote(id, introduce)
    }
    const found = ids.map(speakerOf)
    const unknown = ids.filter((_, i) => !found[i])
    if (unknown.length) return { status: 404, body: { error: `Unknown agent: ${unknown.join(", ")}` } }
    const speakers = found as [TalkSpeaker, TalkSpeaker]
    const talk = new Talk({
      topic, speakers, speech: this.speech,
      context: body.context ? String(body.context) : undefined,
      maxTurns: Math.max(2, Math.min(40, Number(body.maxTurns) || 10)),
      model: (_s, system) => this.model(system),
    })
    talk.on((e) => {
      if (e.type === "line") { this.intros.spoke(session, e.agentId); this.log(`[talk] ${e.name}: ${e.text}`) }
      else if (e.type === "gap") this.log(`[talk] gap ${e.ms} ms`)
      else if (e.type === "error") this.log(`[talk] error: ${e.error}`)
      else if (e.type === "end") this.log(`[talk] ended (${e.reason})`)
    })
    this.session = talk
    void talk.run()
    this.log(`[talk] ${speakers[0].name} and ${speakers[1].name} on "${topic.slice(0, 80)}"`)
    return { status: 201, body: this.view(talk) }
  }

  private kind(t: VoiceSession): "talk" | "lesson" { return t instanceof LiveTeach ? "lesson" : "talk" }
  private agentOf(t: VoiceSession): string | null { return t instanceof LiveTeach ? t.agentId : null }

  private view(t: VoiceSession) {
    if (t instanceof LiveTeach) return { active: t.state !== "ended", kind: "lesson", id: t.id, state: t.state, step: t.step, saying: t.lastSay }
    return { active: t.state !== "ended", kind: "talk", id: t.id, state: t.state, startedAt: t.startedAt, transcript: t.transcript, gaps: t.gaps }
  }
}
