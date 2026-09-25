// --- Live teach: an agent teaches an app it has no lesson for ---
//
// `agentx teach <lesson>` plays a script someone wrote in advance. This is
// the unscripted version: read the screen (accessibility tree, OCR when
// the tree is thin), let a fast model plan ONE step toward the goal, say
// it in the agent's voice while the agent's own cursor points at or
// outlines the control, then either wait for Anis to do it (teach, watch)
// or do it itself (act, only when the agent is allowed to). The screen is
// read again after every step, so the next step starts from what is
// actually there, not from what the plan assumed. It is also read again
// right before the cursor moves and right before a click or type: the
// planner and the spoken line take seconds, and a window that changed
// meanwhile means the plan is about a screen that is gone.
//
// It is a voice session like a talk: hush() and door() are what
// Option-Space calls, and "stop" ends it.

import type { LineModel } from "./talk-model"
import type { SpeechOut, VoiceRef } from "./speaker"
import type { Presence, Rect } from "./presence"
import { bubbleText, findControl, leavesApp, parsePlan, screenSignature, type Plan } from "./live-teach-plan"

export { leavesApp, parsePlan, screenSignature, teachSystemPrompt, type Plan } from "./live-teach-plan"

export type TeachMode = "teach" | "watch" | "act"
export type StepAction = "point" | "highlight" | "click" | "type" | "key" | "wait_for_user" | "done"

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
  /** Press, type or press keys for real. Only ever called in act mode with
   *  actions allowed. `role` is the target's, for the helper's check that
   *  the click lands on it. */
  act(step: { action: "click" | "type"; rect: Rect; label: string; role?: string; text?: string } | { action: "key"; keys: string }): Promise<{ error: string | null }>
}

export interface LiveTeachOpts {
  goal: string
  /** The app this lesson is about. Nothing is planned, and above all
   *  nothing is clicked, while another app has focus. Without one, the
   *  app in front at the first read. */
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
  /** Plans thrown away in a row, because the screen changed before they
   *  were carried out, before the lesson gives up. */
  maxReplans?: number
}

export type TeachEvent =
  | { type: "step"; n: number; action: StepAction; target: string | null; say: string }
  | { type: "changed"; n: number; changed: boolean }
  | { type: "acted"; n: number; error: string | null }
  | { type: "replanned"; n: number; reason: string }
  | { type: "door"; text: string }
  | { type: "end"; reason: string }
  | { type: "error"; error: string }

/** What a plan is carried out on: a read taken after planning, and the
 *  plan's target on it. */
type Fresh = { screen: ScreenView; target: number | null }
/** Why a plan no longer fits the screen. */
type Stale = { stale: string }

/** A read costs about 0.1 s, so a done step is noticed within a second. */
const POLL_MS = 400

const STOP = /^\s*(stop|stop talking|that'?s enough|end( the lesson)?|enough)[\s.!]*$/i

export class LiveTeach {
  readonly id = `teach-${Date.now().toString(36)}`
  /** Whose lesson this is. */
  get agentId(): string | null { return this.opts.speaker.agentId ?? null }
  get mode(): TeachMode { return this.opts.mode }
  get goal(): string { return this.opts.goal }
  readonly startedAt = new Date().toISOString()
  state: "running" | "held" | "ended" = "running"
  step = 0
  lastSay = ""
  private history: string[] = []
  private ac = new AbortController()
  private doorQueue: string[] = []
  /** The line still being spoken while the next step is planned. */
  private speaking: Promise<unknown> = Promise.resolve()
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
    let replans = 0
    try {
      while (!this.is("ended") && this.step < max) {
        await this.waitOutHush()
        if (this.is("ended")) break
        const screen = await this.onLessonApp()
        if (!screen) continue
        const plan = await this.plan(screen)
        if (!plan) continue // interrupted while planning: plan again with what was said
        const fresh = await this.recheck(plan, screen)
        const outcome = "stale" in fresh ? fresh : await this.perform(++this.step, plan, fresh)
        if (outcome === "done" || outcome === "stopped") break
        if (outcome === "next") { replans = 0; continue }
        if (!this.replanned(outcome.stale, ++replans)) break
      }
      await this.speaking // let the last line finish
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
    let asked = false
    const deadline = Date.now() + (this.opts.waitMs ?? 45_000)
    for (;;) {
      const screen = await this.deps.readScreen()
      this.opts.app ??= screen.app
      if (screen.app.toLowerCase() === this.opts.app.toLowerCase()) return screen
      if (!asked) {
        asked = true
        const line = `Bring ${this.opts.app} to the front and I'll carry on.`
        this.deps.presence.say(line)
        this.emit({ type: "step", n: this.step, action: "wait_for_user", target: null, say: line })
        await this.deps.speech.say({ voice: this.opts.speaker.voice, text: line })
      }
      if (Date.now() > deadline) { this.stop(`${this.opts.app} never came to the front`); return null }
      await Promise.race([this.sleep(this.opts.pollMs ?? POLL_MS), this.poked()])
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
        ? `You do each step yourself (click, type or key), telling ${this.listener} what it is for and where: 'to fill it in, I'm clicking solid on the right'.`
        : `You may not click or type here; show where and let ${this.listener} do it.`,
    }[this.opts.mode]
    const prompt = [
      `Goal: ${this.opts.goal}`,
      `Mode: ${this.opts.mode}. ${modeLine}`,
      `App: ${screen.app}${screen.window ? ` — window "${screen.window}"` : ""}`,
      "On screen:",
      ...screen.candidates.slice(0, 80).map((c) => `${c.id} ${c.role} "${c.label.slice(0, 60)}"${c.value ? ` = "${String(c.value).slice(0, 40)}"` : ""}`),
      this.history.length ? `So far:\n${this.history.slice(-8).join("\n")}` : "This is the first step.",
    ].join("\n")
    const signal = this.ac.signal
    let reply = ""
    for await (const d of this.deps.model.reply(prompt, signal)) reply += d
    if (signal.aborted) return null
    return parsePlan(reply, new Set(screen.candidates.map((c) => c.id)))
  }

  /**
   * Read the screen again before carrying out a plan made from `before`.
   * Returns the fresh read with the target found on it, or why the plan
   * no longer fits: another app or window in front, or the target gone.
   * Nothing else counts, so the pointer moving or a tooltip showing up
   * does not throw a plan away; a target that only moved is used where
   * it is now.
   */
  private async recheck(plan: Plan, before: ScreenView): Promise<Fresh | Stale> {
    const now = await this.deps.readScreen()
    if (now.app !== before.app) return { stale: `${now.app} is in front now, not ${before.app}` }
    if ((now.window ?? "") !== (before.window ?? "")) return { stale: `the window changed from "${before.window ?? ""}" to "${now.window ?? ""}"` }
    if (plan.target === null) return { screen: now, target: null }
    const target = findControl(before, plan.target, now)
    if (target !== null) return { screen: now, target }
    const label = before.candidates.find((c) => c.id === plan.target)?.label ?? ""
    return { stale: `"${label}" is no longer on screen` }
  }

  /** A plan was thrown away. False when that has happened too often in a
   *  row, and the lesson has stopped. */
  private replanned(reason: string, inARow: number): boolean {
    this.emit({ type: "replanned", n: this.step, reason })
    this.deps.presence.clear()
    this.history.push(`The screen changed before you acted (${reason}); plan again from what is there now.`)
    if (inARow <= (this.opts.maxReplans ?? 3)) return true
    this.stop("the screen kept changing")
    return false
  }

  /** Show, say, then do or wait; stale when the screen changed before a
   *  click or type. */
  private async perform(n: number, plan: Plan, fresh: Fresh): Promise<"done" | "next" | "stopped" | Stale> {
    const { screen, target } = fresh
    const rect = target !== null ? screen.rectOf(target) : null
    const label = target !== null ? screen.candidates.find((c) => c.id === target)?.label ?? "" : ""
    const mayAct = this.opts.mode === "act" && this.opts.actionsAllowed
    // The lesson never leaves its app to go and find another one.
    if (mayAct && plan.action === "key" && plan.text && leavesApp(plan.text)) return this.refuseToLeave(n, plan.text, screen.app)
    // Click and type only when allowed; otherwise show it instead.
    const action: StepAction =
      plan.action === "key" ? (mayAct && plan.text ? "key" : rect ? "highlight" : "wait_for_user")
      : (plan.action === "click" || plan.action === "type") && (!mayAct || !rect) ? "highlight" : plan.action
    this.emit({ type: "step", n, action, target: label || null, say: plan.say })

    const { presence, speech } = this.deps
    if (rect) presence.moveTo(rect, { highlight: action !== "point" })
    // The voice carries the sentence; the bubble only names what is pointed at.
    presence.say(bubbleText(rect ? label : null))
    this.lastSay = plan.say
    await this.speaking
    const spoken = plan.say ? speech.say({ voice: this.opts.speaker.voice, text: plan.say }) : Promise.resolve(true)
    // Act mode does the step while saying it, and plans the next one while
    // the line plays out, instead of speaking, then pressing, then thinking.
    const acts = mayAct && (action === "key" ? !!plan.text : (action === "click" || action === "type") && !!rect)
    if (acts) this.speaking = spoken
    else await Promise.race([spoken, this.poked()])
    if (!this.is("running") || this.doorQueue.length) {
      this.history.push(`Step ${n}: you started "${plan.say}" and were cut off.`)
      return this.is("ended") ? "stopped" : "next"
    }
    if (action === "done") return "done"

    if (action === "key" && plan.text) {
      const now = await this.recheck({ ...plan, target: null }, screen)
      if ("stale" in now) return now
      const r = await this.deps.act({ action: "key", keys: plan.text })
      this.emit({ type: "acted", n, error: r.error })
      this.history.push(r.error ? `Step ${n}: you tried to press ${plan.text} and it failed: ${r.error}` : `Step ${n}: you pressed ${plan.text}.`)
      if (!r.error) await this.settle()
      return "next"
    }

    if ((action === "click" || action === "type") && rect) {
      // Press only what is there now, not what was planned against.
      const now = await this.recheck({ ...plan, target }, screen)
      if ("stale" in now) return now
      const at = now.target !== null ? now.screen.rectOf(now.target) : null
      if (!at) return { stale: `"${label}" is no longer on screen` }
      const role = screen.candidates.find((c) => c.id === target)?.role
      const r = await this.deps.act({ action, rect: at, label, role, text: plan.text ?? undefined })
      this.emit({ type: "acted", n, error: r.error })
      this.history.push(r.error
        ? `Step ${n}: you tried to ${action} "${label}" and it failed: ${r.error}`
        : `Step ${n}: you ${action === "click" ? "clicked" : `typed "${plan.text}" into`} "${label}".`)
      // Let the app react before the next read: a window that opens late
      // would otherwise be planned against as if it were not there.
      if (!r.error) await this.settle()
      return "next"
    }

    // Everything else waits for the listener to act on the step.
    const changed = await this.waitForChange()
    // Hand control back: the cursor returns to the listener's own pointer.
    presence.say("")
    presence.park()
    this.emit({ type: "changed", n, changed })
    this.history.push(`Step ${n}: you said "${plan.say}"${label ? ` about "${label}"` : ""}. ` +
      (changed ? `${this.listener} did something; the screen changed.` : `Nothing changed on screen.`))
    return "next"
  }

  /** A key that would leave the lesson's app: say so and stop, pressing nothing. */
  private async refuseToLeave(n: number, keys: string, app: string): Promise<"stopped"> {
    const line = `That would take me out of ${app}, so I'll stop here.`
    this.emit({ type: "acted", n, error: `refused ${keys}: it leaves ${app}` })
    await this.speaking
    this.deps.presence.say(line)
    await this.deps.speech.say({ voice: this.opts.speaker.voice, text: line })
    this.stop(`${keys} would leave ${app}`)
    return "stopped"
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
      await Promise.race([this.sleep(this.opts.pollMs ?? POLL_MS), this.poked()])
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
      await this.sleep(Math.min(POLL_MS, this.opts.pollMs ?? POLL_MS))
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
