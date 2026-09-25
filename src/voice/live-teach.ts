// --- Live teach: an agent teaches an app it has no lesson for ---
//
// `agentx teach <lesson>` plays a script someone wrote in advance. This is
// the unscripted version: read the screen (accessibility tree, OCR when
// the tree is thin), let a fast model plan ONE step toward the goal, say
// it in the agent's voice while the agent's own cursor points at or
// outlines the control, then either wait for Anis to do it (teach, watch)
// or do it itself (act, only when the agent is allowed to). The screen is
// read again after every step, so the next step starts from what is
// actually there, not from what the plan assumed.
//
// It is a voice session like a talk: hush() and door() are what
// Option-Space calls, and "stop" ends it.

import type { LineModel } from "./talk-model"
import type { SpeechOut, VoiceRef } from "./speaker"
import type { Presence, Rect } from "./presence"
import { parsePlan, screenSignature, type Plan } from "./live-teach-plan"

export { parsePlan, screenSignature, teachSystemPrompt, type Plan } from "./live-teach-plan"

export type TeachMode = "teach" | "watch" | "act"
export type StepAction = "point" | "highlight" | "click" | "type" | "wait_for_user" | "done"

export interface ScreenView {
  app: string
  window: string | null
  candidates: Array<{ id: number; role: string; label: string; value?: string | null }>
  rectOf(id: number): Rect | null
}

export interface TeachDeps {
  readScreen(): Promise<ScreenView>
  presence: Presence
  speech: SpeechOut
  /** The planner: a warm fast model holding this lesson's history. */
  model: LineModel
  /** Press or type for real. Only ever called in act mode with actions allowed. */
  act(step: { action: "click" | "type"; rect: Rect; label: string; text?: string }): Promise<{ error: string | null }>
}

export interface LiveTeachOpts {
  goal: string
  /** The app this lesson is about. Nothing is planned, and above all
   *  nothing is clicked, while another app has focus. */
  app?: string
  mode: TeachMode
  speaker: { name: string; voice: VoiceRef; agentId?: string }
  actionsAllowed: boolean
  listener?: string
  maxSteps?: number
  /** How long to wait for the listener to do a step. */
  waitMs?: number
  pollMs?: number
  holdMs?: number
}

export type TeachEvent =
  | { type: "step"; n: number; action: StepAction; target: string | null; say: string }
  | { type: "changed"; n: number; changed: boolean }
  | { type: "acted"; n: number; error: string | null }
  | { type: "door"; text: string }
  | { type: "end"; reason: string }
  | { type: "error"; error: string }

const STOP = /^\s*(stop|stop talking|that'?s enough|end( the lesson)?|enough)[\s.!]*$/i

export class LiveTeach {
  readonly id = `teach-${Date.now().toString(36)}`
  /** Whose lesson this is. */
  get agentId(): string | null { return this.opts.speaker.agentId ?? null }
  state: "running" | "held" | "ended" = "running"
  step = 0
  lastSay = ""
  private history: string[] = []
  private ac = new AbortController()
  private doorQueue: string[] = []
  private wake: (() => void) | null = null
  private listeners: Array<(e: TeachEvent) => void> = []
  private readonly listener: string

  constructor(private opts: LiveTeachOpts, private deps: TeachDeps) {
    this.listener = opts.listener ?? "Anis"
  }

  on(fn: (e: TeachEvent) => void): void { this.listeners.push(fn) }

  door(text: string): void {
    if (this.state === "ended") return
    if (STOP.test(text)) return this.stop("stopped by the listener")
    this.silence()
    this.doorQueue.push(text.trim())
    this.state = "running"
    this.emit({ type: "door", text })
    this.poke()
  }

  hush(): void {
    if (this.state !== "running") return
    this.silence()
    this.state = "held"
    this.poke()
  }

  stop(reason = "stopped"): void {
    if (this.state === "ended") return
    this.state = "ended"
    this.silence()
    this.deps.presence.say("")
    this.deps.presence.close()
    this.deps.model.close()
    this.emit({ type: "end", reason })
    this.poke()
  }

  async run(): Promise<void> {
    const max = this.opts.maxSteps ?? 12
    try {
      while (!this.is("ended") && this.step < max) {
        await this.waitOutHush()
        if (this.is("ended")) break
        const screen = await this.onLessonApp()
        if (!screen) continue
        const plan = await this.plan(screen)
        if (!plan) continue // interrupted while planning: plan again with what was said
        const n = ++this.step
        const done = await this.perform(n, plan, screen)
        if (done) break
      }
      if (!this.is("ended")) this.stop(this.step >= max ? "step limit" : "goal reached")
    } catch (e: any) {
      this.emit({ type: "error", error: String(e?.message ?? e) })
      this.stop("error")
    }
  }

  // --- internals ---

  /** The screen, once the lesson's app has focus. Anything else in front
   *  (the terminal that started this, a browser) is not what the lesson
   *  is about, and acting on it would be acting on the wrong app. */
  private async onLessonApp(): Promise<ScreenView | null> {
    const want = this.opts.app?.toLowerCase()
    let asked = false
    const deadline = Date.now() + (this.opts.waitMs ?? 45_000)
    for (;;) {
      const screen = await this.deps.readScreen()
      if (!want || screen.app.toLowerCase() === want) return screen
      if (!asked) {
        asked = true
        const line = `Bring ${this.opts.app} to the front and I'll carry on.`
        this.deps.presence.say(line)
        this.emit({ type: "step", n: this.step, action: "wait_for_user", target: null, say: line })
        await this.deps.speech.say({ voice: this.opts.speaker.voice, text: line })
      }
      if (Date.now() > deadline) { this.stop(`${this.opts.app} never came to the front`); return null }
      await Promise.race([this.sleep(this.opts.pollMs ?? 800), this.poked()])
      if (!this.is("running")) return null
    }
  }

  private async plan(screen: ScreenView): Promise<Plan | null> {
    const said = this.doorQueue.splice(0)
    if (said.length) this.history.push(`${this.listener} said: "${said.join(" / ")}" — answer that first.`)
    const modeLine = {
      teach: `You lead: say the next step, show where, and ${this.listener} does it.`,
      watch: `${this.listener} is driving. Coach briefly: where things are and what to try next. Prefer wait_for_user.`,
      act: this.opts.actionsAllowed
        ? "You do each step yourself (click or type), saying what you are doing."
        : `You may not click or type here; show where and let ${this.listener} do it.`,
    }[this.opts.mode]
    const prompt = [
      `Goal: ${this.opts.goal}`,
      `Mode: ${this.opts.mode}. ${modeLine}`,
      `App: ${screen.app}${screen.window ? ` — window "${screen.window}"` : ""}`,
      "On screen:",
      ...screen.candidates.slice(0, 45).map((c) => `${c.id} ${c.role} "${c.label.slice(0, 60)}"${c.value ? ` = "${String(c.value).slice(0, 40)}"` : ""}`),
      this.history.length ? `So far:\n${this.history.slice(-8).join("\n")}` : "This is the first step.",
    ].join("\n")
    const signal = this.ac.signal
    let reply = ""
    for await (const d of this.deps.model.reply(prompt, signal)) reply += d
    if (signal.aborted) return null
    return parsePlan(reply, new Set(screen.candidates.map((c) => c.id)))
  }

  /** Show, say, then do or wait. Returns true when the lesson is over. */
  private async perform(n: number, plan: Plan, screen: ScreenView): Promise<boolean> {
    const rect = plan.target !== null ? screen.rectOf(plan.target) : null
    const label = plan.target !== null ? screen.candidates.find((c) => c.id === plan.target)?.label ?? "" : ""
    const mayAct = this.opts.mode === "act" && this.opts.actionsAllowed
    // Click and type only when allowed; otherwise show it instead.
    const action: StepAction = (plan.action === "click" || plan.action === "type") && (!mayAct || !rect) ? "highlight" : plan.action
    this.emit({ type: "step", n, action, target: label || null, say: plan.say })

    const { presence, speech } = this.deps
    if (rect) presence.moveTo(rect, { highlight: action !== "point" })
    presence.say(plan.say)
    this.lastSay = plan.say
    const spoken = plan.say ? speech.say({ voice: this.opts.speaker.voice, text: plan.say }) : Promise.resolve(true)
    await Promise.race([spoken, this.poked()])
    if (!this.is("running") || this.doorQueue.length) {
      this.history.push(`Step ${n}: you started "${plan.say}" and were cut off.`)
      return false
    }
    if (action === "done") return true

    if ((action === "click" || action === "type") && rect) {
      const r = await this.deps.act({ action, rect, label, text: plan.text ?? undefined })
      this.emit({ type: "acted", n, error: r.error })
      this.history.push(r.error
        ? `Step ${n}: you tried to ${action} "${label}" and it failed: ${r.error}`
        : `Step ${n}: you ${action === "click" ? "clicked" : `typed "${plan.text}" into`} "${label}".`)
      // Let the app react before the next read: a window that opens late
      // would otherwise be planned against as if it were not there.
      if (!r.error) await this.settle()
      return false
    }

    // Everything else waits for the listener to act on the step.
    const changed = await this.waitForChange()
    presence.clear()
    this.emit({ type: "changed", n, changed })
    this.history.push(`Step ${n}: you said "${plan.say}"${label ? ` about "${label}"` : ""}. ` +
      (changed ? `${this.listener} did something; the screen changed.` : `Nothing changed on screen.`))
    return false
  }

  /** Poll until the screen settles into something new, the listener
   *  speaks, or the wait runs out.
   *
   *  The baseline is read now, after the step was said, not before it was
   *  planned: apps keep loading while the model thinks (a file list
   *  filling in), and that is not the listener doing the step. A change
   *  must also hold for two reads, so a spinner does not count. */
  private async waitForChange(): Promise<boolean> {
    const before = await this.signature()
    const deadline = Date.now() + (this.opts.waitMs ?? 45_000)
    let candidate: string | null = null
    while (Date.now() < deadline && this.is("running") && !this.doorQueue.length) {
      await Promise.race([this.sleep(this.opts.pollMs ?? 800), this.poked()])
      if (!this.is("running") || this.doorQueue.length) return false
      const now = await this.signature()
      if (now === null || now === before) { candidate = null; continue }
      if (now === candidate) return true
      candidate = now
    }
    return false
  }

  /** After acting: wait until two reads in a row agree, at most 3 s. */
  private async settle(): Promise<void> {
    const deadline = Date.now() + 3_000
    let last = await this.signature()
    while (Date.now() < deadline && this.is("running")) {
      await this.sleep(Math.min(400, this.opts.pollMs ?? 400))
      const now = await this.signature()
      if (now === last) return
      last = now
    }
  }

  private async signature(): Promise<string | null> {
    try { return screenSignature(await this.deps.readScreen()) } catch { return null }
  }

  private async waitOutHush(): Promise<void> {
    const deadline = Date.now() + (this.opts.holdMs ?? 20_000)
    while (this.is("held") && Date.now() < deadline) await Promise.race([this.poked(), this.sleep(deadline - Date.now())])
    if (this.is("held")) this.state = "running"
  }

  private silence(): void {
    this.deps.speech.stop()
    this.ac.abort()
    this.ac = new AbortController()
  }

  private is(s: LiveTeach["state"]): boolean { return this.state === s }
  private sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, Math.max(0, ms))) }
  private poke(): void { const w = this.wake; this.wake = null; w?.() }
  private poked(): Promise<void> { return new Promise((r) => { this.wake = r }) }
  private emit(e: TeachEvent): void {
    for (const fn of this.listeners) { try { fn(e) } catch { /* never break the lesson */ } }
  }
}
