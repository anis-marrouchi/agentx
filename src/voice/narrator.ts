// --- Task narration: an agent says what it is doing, from its real steps ---
//
// While an agent runs a real task, its tool calls arrive as task:step
// events. Every ~20 s at most, the steps taken since the last line become
// one short first-person sentence in that agent's voice. Nothing is
// invented: the model sees only those steps and may answer SKIP.
//
// Off unless switched on, per agent (`voice.narrate` in agentx.json) or at
// runtime per agent or task. "on" skips cron work; "all" includes it.
// Voice-app turns are skipped: the app narrates those itself.

import type { TypedEventBus, AgentXEvents } from "@/events/bus"
import type { LineModel } from "./talk-model"
import type { SpeechOut } from "./speaker"
import { speakable } from "./sentences"

export type NarrateMode = "off" | "on" | "all"

export interface NarratorVoice {
  name: string
  voiceId: string
  style?: string | null
  narrate: NarrateMode
}

export interface NarratorOpts {
  speech: SpeechOut
  /** Created on first use, closed after `idleMs` without a line. */
  model: () => LineModel
  voiceOf: (agentId: string) => NarratorVoice | null
  minGapMs?: number
  firstDelayMs?: number
  idleMs?: number
}

export const NARRATOR_SYSTEM =
  "You turn an AI agent's real tool steps into one short spoken sentence, in the first person, as that agent. " +
  "Say what it is doing now in plain words, lively but brief (under 20 words). Mention only what the steps show; " +
  "never invent progress or results. Never read out commands, file paths, code, ids, numbers, names of secrets or " +
  "anything that looks like a key. If the steps show nothing worth saying, answer exactly SKIP."

const SKIPPED_CHANNELS = new Set(["voice", "desktop"])

interface TaskState {
  agentId: string
  channel: string
  steps: string[]
  lastSpokeAt: number
  timer?: NodeJS.Timeout
}

/** Keep a step readable but strip what should never be spoken or sent. */
export function stepLine(action: string, input: string): string {
  const clean = input
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "…")
    .replace(/(token|key|secret|password|passwd|auth)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "$1=…")
    .slice(0, 200)
  return `${action}: ${clean}`
}

export class Narrator {
  private tasks = new Map<string, TaskState>()
  private agentSwitch = new Map<string, boolean>()
  private taskSwitch = new Map<string, boolean>()
  private model: LineModel | null = null
  private idleTimer?: NodeJS.Timeout
  private readonly minGap: number
  private readonly firstDelay: number
  /** Set by the door: no narration until then. */
  private heldUntil = 0
  /** The task narrated most recently, and when. */
  private lastLine: { taskId: string; agentId: string; at: number } | null = null

  constructor(private opts: NarratorOpts) {
    this.minGap = opts.minGapMs ?? 20_000
    this.firstDelay = opts.firstDelayMs ?? 4_000
  }

  /** Runtime switch; null clears it back to the configured default. */
  set(target: { agentId?: string; taskId?: string }, on: boolean | null): void {
    const [map, key] = target.taskId ? [this.taskSwitch, target.taskId] : [this.agentSwitch, target.agentId ?? ""]
    if (!key) return
    if (on === null) map.delete(key)
    else map.set(key, on)
  }

  /**
   * The listener pressed the door: hold narration for a while (the audio
   * itself is stopped by the shared SpeechOut). Returns the task that was
   * narrated in the last `recentMs`, which is what the listener heard.
   */
  hush(holdMs = 30_000, recentMs = 30_000): { taskId: string; agentId: string } | null {
    this.heldUntil = Date.now() + holdMs
    const l = this.lastLine
    return l && Date.now() - l.at < recentMs ? { taskId: l.taskId, agentId: l.agentId } : null
  }

  /** The listener has spoken: narration may carry on. */
  release(): void { this.heldUntil = 0 }

  status(): { agents: Record<string, boolean>; tasks: Record<string, boolean> } {
    return { agents: Object.fromEntries(this.agentSwitch), tasks: Object.fromEntries(this.taskSwitch) }
  }

  enabled(agentId: string, channel: string, taskId: string): boolean {
    const t = this.taskSwitch.get(taskId)
    if (t !== undefined) return t
    if (SKIPPED_CHANNELS.has(channel)) return false
    const a = this.agentSwitch.get(agentId)
    const mode = this.opts.voiceOf(agentId)?.narrate ?? "off"
    const on = a ?? mode !== "off"
    // Cron work stays quiet unless the agent says "all" (or the task is
    // switched on by id, above).
    return on && (channel !== "cron" || mode === "all")
  }

  attach(bus: TypedEventBus): () => void {
    const started = (e: AgentXEvents["task:started"]) => {
      if (e.taskId) this.tasks.set(e.taskId, { agentId: e.agentId, channel: e.channel, steps: [], lastSpokeAt: 0 })
    }
    const step = (e: AgentXEvents["task:step"]) => this.onStep(e)
    const done = (e: AgentXEvents["task:completed"]) => {
      const s = e.taskId ? this.tasks.get(e.taskId) : undefined
      if (s?.timer) clearTimeout(s.timer)
      if (e.taskId) { this.tasks.delete(e.taskId); this.taskSwitch.delete(e.taskId) }
    }
    bus.on("task:started", started)
    bus.on("task:step", step)
    bus.on("task:completed", done)
    return () => {
      bus.off("task:started", started)
      bus.off("task:step", step)
      bus.off("task:completed", done)
      this.close()
    }
  }

  onStep(e: AgentXEvents["task:step"]): void {
    if (e.name !== "tool_use" || !e.action) return
    const s = this.tasks.get(e.taskId)
    if (!s || !this.enabled(s.agentId, s.channel, e.taskId)) return
    s.steps.push(stepLine(e.action, e.inputSummary ?? ""))
    if (s.timer) return
    const now = Date.now()
    const at = s.lastSpokeAt ? s.lastSpokeAt + this.minGap : now + this.firstDelay
    s.timer = setTimeout(() => { s.timer = undefined; void this.flush(e.taskId) }, Math.max(0, at - now))
  }

  /** Speak one line about the steps gathered for a task, if any. */
  async flush(taskId: string): Promise<string | null> {
    const s = this.tasks.get(taskId)
    const voice = s && this.opts.voiceOf(s.agentId)
    if (!s || !voice || !s.steps.length) return null
    const steps = s.steps.splice(0)
    s.lastSpokeAt = Date.now()
    if (Date.now() < this.heldUntil) return null
    // A talk (or another line) is already speaking: skip rather than queue
    // a stale update behind it.
    if (this.opts.speech.busy) return null
    const prompt = [
      `You are ${voice.name}${voice.style ? `; your manner: ${voice.style}` : ""}.`,
      "Your real steps since your last update:",
      ...steps.slice(-12).map((l) => `- ${l}`),
    ].join("\n")
    let text = ""
    try {
      for await (const d of this.useModel().reply(prompt)) text += d
    } catch {
      this.closeModel()
      return null
    }
    const line = speakable(text)
    if (!line || /^SKIP\b/i.test(line)) return null
    if (Date.now() < this.heldUntil) return null
    this.lastLine = { taskId, agentId: s.agentId, at: Date.now() }
    void this.opts.speech.say({ voiceId: voice.voiceId, text: line })
    return line
  }

  close(): void {
    for (const s of this.tasks.values()) if (s.timer) clearTimeout(s.timer)
    this.tasks.clear()
    this.closeModel()
  }

  private useModel(): LineModel {
    this.model ??= this.opts.model()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.closeModel(), this.opts.idleMs ?? 180_000)
    this.idleTimer.unref?.()
    return this.model
  }

  private closeModel(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.model?.close()
    this.model = null
  }
}
