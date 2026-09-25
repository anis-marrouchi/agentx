// Voice for agents on other mesh nodes, through this daemon.
//
// /ask accepts a remote agent id: the turn goes to the peer that hosts it
// over the existing mesh /task path, and the reply comes back as if the
// agent were local. The voice stays here: TTS, introductions and the
// door all run on this Mac (see src/voice/mesh-voice.ts).
//
// A voice session can also switch who it is talking to: "talk to Atlas"
// sends that session's following turns to Atlas until "back to secretary".

import type { A2AMesh } from "@/a2a/mesh"
import { MeshVoices, loadVoicePool, parseVoiceSwitch } from "@/voice/mesh-voice"
import type { AgentVoice } from "@/voice/agent-voice"
import { elevenLabsKey } from "@/voice/speaker"
import type { DaemonConfig } from "@/daemon/config"

const MAX_SESSIONS = 500
/** A voice turn nobody is waiting for after this is not worth holding. */
const REMOTE_TIMEOUT_MS = 10 * 60 * 1000

export interface RemoteReply { content: string; error?: string; duration: number; peer: string }

export class VoiceMeshProxy {
  readonly voices: MeshVoices
  /** voice session → the agent it is talking to, when not the requested one. */
  private targets = new Map<string, string>()

  constructor(
    private config: () => DaemonConfig,
    private mesh: () => Pick<A2AMesh, "directory" | "sendTask"> | undefined,
    private log: (msg: string) => void = () => {},
  ) {
    this.voices = new MeshVoices(config, () => this.mesh()?.directory() ?? [])
  }

  /** Load the account's voice list once, so remotes get distinct voices. */
  async loadPool(): Promise<void> {
    const pool = await loadVoicePool(elevenLabsKey())
    this.voices.usePool(pool)
    this.log(`[voice] ${pool.length} voices available for mesh agents`)
  }

  /** The agent this session talks to: a switched-to target, or the one asked for. */
  target(session: string, requested: string): string {
    return this.targets.get(session) ?? requested
  }

  /**
   * "talk to Atlas" / "back to secretary": the agent now answering this
   * session, or null when the message is not a switch to a known agent
   * ("talk to me about the budget" is an ordinary question).
   */
  switchTo(session: string, message: string, requested: string): string | null {
    const named = parseVoiceSwitch(message)
    const agentId = named ? this.voices.resolve(named) : undefined
    if (!agentId) return null
    this.targets.delete(session)
    if (agentId !== requested) {
      this.targets.set(session, agentId)
      if (this.targets.size > MAX_SESSIONS) this.targets.delete(this.targets.keys().next().value as string)
    }
    return agentId
  }

  isRemote(agentId: string): boolean {
    return !!this.voices.get(agentId)
  }

  /** Local and mesh agent ids, for an "unknown agent" answer. */
  known(): { local: string[]; mesh: string[] } {
    return { local: Object.keys(this.config().agents), mesh: this.voices.list().map((a) => a.id) }
  }

  /**
   * One voice turn on the agent's own node. The session there is keyed by
   * (agent, "voice", "voice:<this node>") and never forced fresh, so the
   * agent keeps the thread across turns just as a local one does.
   */
  async ask(agentId: string, message: string, voice: AgentVoice, introduce: boolean): Promise<RemoteReply> {
    const agent = this.voices.get(agentId)
    const mesh = this.mesh()
    if (!agent || !mesh) return { content: "", error: `Unknown agent: "${agentId}"`, duration: 0, peer: "" }
    const started = Date.now()
    try {
      const content = await mesh.sendTask(agent.peer, message, agentId, {
        context: {
          channel: "voice",
          chatId: `voice:${this.config().node.id}`,
          sender: "Voice",
          voice: { introduce, intro: voice.intro, style: voice.style ?? undefined },
        },
        freshSession: false,
        timeoutMs: REMOTE_TIMEOUT_MS,
      })
      const duration = Date.now() - started
      this.log(`[voice] ${agentId}@${agent.peer} answered in ${duration}ms`)
      return { content, duration, peer: agent.peer }
    } catch (e: any) {
      const duration = Date.now() - started
      this.log(`[voice] ${agentId}@${agent.peer} failed after ${duration}ms: ${e?.message ?? e}`)
      return { content: "", error: String(e?.message ?? e), duration, peer: agent.peer }
    }
  }
}
