// Talk mode and task narration on the daemon (see src/voice/talk.ts and
// src/voice/narrator.ts). One talk at a time: they share the host's
// speakers, and two conversations at once would be noise.
//
//   POST /talk        {agents: [a, b], topic, context?, maxTurns?}  start one
//   GET  /talk        the active talk (or {active: false})
//   POST /talk/hush   the listener is about to speak: everyone stops
//   POST /talk/door   {text}  the listener spoke; "stop" ends the talk
//   POST /talk/stop
//   GET  /narration   runtime switches
//   POST /narration   {agentId? | taskId?, on: true | false | null}
//
// Same gate as /ask: each of these makes the host speak.

import type { DaemonConfig } from "@/daemon/config"
import { Talk, type TalkSpeaker } from "@/voice/talk"
import { Narrator } from "@/voice/narrator"
import { SpeechOut } from "@/voice/speaker"
import { createLineModel, type LineModel } from "@/voice/talk-model"
import { introInstruction, pickVoiceId, resolveAgentVoice, type VoiceIntroTracker } from "@/voice/agent-voice"
import { NARRATOR_SYSTEM } from "@/voice/narrator"

type Agents = DaemonConfig["agents"]
export type Reply = { status: number; body: unknown }

/** An agent as a talk participant: who it is, how it sounds, whether it
 *  still owes the listener an introduction. */
export function talkSpeaker(agentId: string, agents: Agents, introduce: boolean): TalkSpeaker {
  const agent = agents[agentId]
  const voice = resolveAgentVoice(agentId, agent)
  // The first paragraph is where a persona says who it is; the rest is
  // task instructions, which do not belong in small talk.
  const persona = (agent?.systemPrompt ?? "").split(/\n\s*\n/)[0].slice(0, 600).trim()
  return {
    agentId,
    name: voice.name,
    voiceId: pickVoiceId(null, voice.elevenlabsVoiceId),
    persona: persona || `You are ${voice.name}.`,
    introLine: introInstruction(voice, introduce),
  }
}

/** Swapped in tests: no real model process, no real audio. */
export interface VoiceTalkDeps {
  speech?: SpeechOut
  model?: (system: string) => LineModel
}

export class VoiceTalkService {
  readonly speech: SpeechOut
  readonly narrator: Narrator
  private talk: Talk | null = null
  private model: (system: string) => LineModel

  constructor(
    private agents: () => Agents,
    private intros: VoiceIntroTracker,
    private log: (msg: string) => void = () => {},
    deps: VoiceTalkDeps = {},
  ) {
    this.speech = deps.speech ?? new SpeechOut()
    this.model = deps.model ?? ((system) => createLineModel({ system }))
    this.narrator = new Narrator({
      speech: this.speech,
      model: () => this.model(NARRATOR_SYSTEM),
      voiceOf: (id) => {
        const agent = this.agents()[id]
        if (!agent) return null
        const v = resolveAgentVoice(id, agent)
        return { name: v.name, voiceId: pickVoiceId(null, v.elevenlabsVoiceId), style: v.style, narrate: agent.voice?.narrate ?? "off" }
      },
    })
  }

  handle(method: string, path: string, body: Record<string, unknown>): Reply {
    const talk = this.talk?.state === "ended" ? null : this.talk
    switch (`${method} ${path}`) {
      case "GET /talk":
        return { status: 200, body: talk ? this.view(talk) : { active: false } }
      case "POST /talk":
        return this.start(body)
      case "POST /talk/hush":
        talk?.hush()
        return { status: 200, body: { active: !!talk } }
      case "POST /talk/door": {
        const text = String(body.text ?? "").trim()
        if (!text) return { status: 400, body: { error: "Required: text" } }
        if (!talk) return { status: 409, body: { active: false, error: "No talk is running" } }
        talk.door(text)
        return { status: 200, body: { active: talk.state !== "ended" } }
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

  close(): void {
    this.talk?.stop("daemon stopping")
    this.narrator.close()
  }

  private start(body: Record<string, unknown>): Reply {
    if (this.talk && this.talk.state !== "ended") return { status: 409, body: { error: "A talk is already running", ...this.view(this.talk) } }
    const ids = Array.isArray(body.agents) ? body.agents.map(String) : []
    const topic = String(body.topic ?? "").trim()
    const agents = this.agents()
    if (ids.length !== 2 || ids[0] === ids[1] || !topic) return { status: 400, body: { error: "Required: agents (two different ids) and topic" } }
    const unknown = ids.filter((id) => !agents[id])
    if (unknown.length) return { status: 404, body: { error: `Unknown agent: ${unknown.join(", ")}` } }

    const session = "talk"
    const speakers = ids.map((id) => talkSpeaker(id, agents, this.intros.needsIntro(session, id))) as [TalkSpeaker, TalkSpeaker]
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
    this.talk = talk
    void talk.run()
    this.log(`[talk] ${speakers[0].name} and ${speakers[1].name} on "${topic.slice(0, 80)}"`)
    return { status: 201, body: this.view(talk) }
  }

  private view(t: Talk) {
    return { active: t.state !== "ended", id: t.id, state: t.state, startedAt: t.startedAt, transcript: t.transcript, gaps: t.gaps }
  }
}
