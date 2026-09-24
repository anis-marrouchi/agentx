import { describe, it, expect } from "vitest"
import { LiveTeach, parsePlan, type ScreenView, type TeachDeps, type TeachMode } from "../src/voice/live-teach"
import { presenceLook, type Presence } from "../src/voice/presence"
import { Channel, type LineModel } from "../src/voice/talk-model"
import { toPresence, type PresenceModeAnswers } from "../src/decisions/seats/presence-mode"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A tiny app: a "New" button; pressing it opens a document window. */
function fakeApp() {
  let docOpen = false
  const view = (): ScreenView => ({
    app: "Notes", window: docOpen ? "Untitled" : "Welcome",
    candidates: docOpen
      ? [{ id: 1, role: "AXButton", label: "New" }, { id: 2, role: "AXTextArea", label: "Body" }]
      : [{ id: 1, role: "AXButton", label: "New" }],
    rectOf: (id) => ({ x: 10 * id, y: 20, width: 60, height: 24 }),
  })
  return { view, open: () => { docOpen = true } }
}

class PlanModel implements LineModel {
  prompts: string[] = []
  closed = false
  constructor(private replies: string[], private delay = 2) {}
  reply(message: string, signal?: AbortSignal): AsyncIterable<string> {
    this.prompts.push(message)
    const text = this.replies.shift() ?? "TARGET: none\nACTION: done\nSAY: That's it."
    const c = new Channel<string>()
    setTimeout(() => { c.push(text); c.end() }, this.delay)
    return c.read(signal)
  }
  close() { this.closed = true }
}

function setup(mode: TeachMode, replies: string[], opts: { actionsAllowed?: boolean; userActsAfter?: number; speakMs?: number } = {}) {
  const app = fakeApp()
  const log: string[] = []
  const presence: Presence = {
    moveTo: (r, o) => log.push(`move ${r.x} ${o?.highlight ? "highlight" : "point"}`),
    say: (t) => { if (t) log.push(`bubble ${t}`) },
    clear: () => log.push("clear"), park: () => log.push("park"), close: () => log.push("close"),
  }
  const said: string[] = []
  let stopped = 0
  const speech = {
    busy: false,
    say: async (u: { text: string }) => { said.push(u.text); await sleep(opts.speakMs ?? 5); return true },
    stop: () => { stopped++ },
  } as any
  const acted: string[] = []
  const model = new PlanModel(replies)
  const deps: TeachDeps = {
    readScreen: async () => app.view(), presence, speech, model,
    act: async (s) => { acted.push(`${s.action} ${s.label}`); app.open(); return { error: null } },
  }
  if (opts.userActsAfter !== undefined) setTimeout(app.open, opts.userActsAfter)
  const t = new LiveTeach({
    goal: "start a new note", mode, speaker: { name: "Coder", voiceId: "roger" },
    actionsAllowed: !!opts.actionsAllowed, waitMs: 300, pollMs: 10, holdMs: 100,
  }, deps)
  return { t, log, said, acted, model, get stopped() { return stopped } }
}

const STEP1 = "TARGET: 1\nACTION: click\nSAY: Click New to start a note."
const DONE = "TARGET: 2\nACTION: done\nSAY: There's your note."

describe("parsePlan", () => {
  it("reads the four fields and refuses ids that are not on screen", () => {
    expect(parsePlan("TARGET: 7\nACTION: Highlight\nTEXT: none\nSAY: **Look** here.", new Set([7])))
      .toEqual({ target: 7, action: "highlight", text: null, say: "Look here." })
    expect(parsePlan("TARGET: 99\nACTION: jump\nSAY: Hmm.", new Set([7])))
      .toEqual({ target: null, action: "wait_for_user", text: null, say: "Hmm." })
  })
})

describe("LiveTeach", () => {
  it("teach: shows and says the step with its own cursor, waits for Anis, never clicks", async () => {
    const s = setup("teach", [STEP1, DONE], { userActsAfter: 40 })
    await s.t.run()
    expect(s.acted).toEqual([])
    expect(s.log).toContain("move 10 highlight")
    expect(s.log).toContain("bubble Click New to start a note.")
    expect(s.said).toEqual(["Click New to start a note.", "There's your note."])
    // The second plan saw the new screen and knew Anis had done the step.
    expect(s.model.prompts[1]).toContain('window "Untitled"')
    expect(s.model.prompts[1]).toContain("Anis did something; the screen changed.")
    expect(s.t.state).toBe("ended")
    expect(s.log.at(-1)).toBe("close")
  })

  it("act: clicks for real only when actions are allowed", async () => {
    const allowed = setup("act", [STEP1, DONE], { actionsAllowed: true })
    await allowed.t.run()
    expect(allowed.acted).toEqual(["click New"])
    expect(allowed.model.prompts[1]).toContain('you clicked "New"')

    const denied = setup("act", [STEP1, DONE], { actionsAllowed: false, userActsAfter: 40 })
    await denied.t.run()
    expect(denied.acted).toEqual([])
    expect(denied.log).toContain("move 10 highlight")
  })

  it("the door cuts in: speech stops and the next plan answers Anis first", async () => {
    const s = setup("teach", [STEP1, "TARGET: none\nACTION: wait_for_user\nSAY: It's the plus-shaped button.", DONE], { speakMs: 200 })
    const run = s.t.run()
    await sleep(40)
    s.t.door("which one is New?")
    await run
    expect(s.stopped).toBeGreaterThan(0)
    expect(s.model.prompts[1]).toContain('Anis said: "which one is New?"')
    expect(s.model.prompts[1]).toContain("were cut off")
  })

  it("a flickering screen (a spinner, a list still loading) is not the listener doing the step", async () => {
    const s = setup("teach", ["TARGET: 1\nACTION: highlight\nSAY: Click New.", DONE])
    let n = 0
    const events: any[] = []
    ;(s.t as any).deps.readScreen = async () => ({
      app: "Notes", window: "Welcome", rectOf: () => ({ x: 1, y: 1, width: 1, height: 1 }),
      candidates: [{ id: 1, role: "AXButton", label: "New" }, { id: 2, role: "AXBusyIndicator", label: `${n++ % 2}` }],
    })
    s.t.on((e) => events.push(e))
    await s.t.run()
    expect(events.find((e) => e.type === "changed")).toEqual({ type: "changed", n: 1, changed: false })
  })

  it("never plans or acts while another app has focus", async () => {
    const s = setup("act", [STEP1, DONE], { actionsAllowed: true })
    let front = "Google Chrome"
    ;(s.t as any).opts.app = "Notes"
    const inner = (s.t as any).deps.readScreen
    ;(s.t as any).deps.readScreen = async () => ({ ...(await inner()), app: front })
    setTimeout(() => { front = "Notes" }, 60)
    await s.t.run()
    expect(s.said[0]).toBe("Bring Notes to the front and I'll carry on.")
    // The first plan only happened once Notes was in front.
    expect(s.model.prompts[0]).toContain("App: Notes")
    expect(s.acted).toEqual(["click New"])
  })

  it("stop ends the lesson and removes the presence", async () => {
    const s = setup("watch", [STEP1], { speakMs: 100 })
    const run = s.t.run()
    await sleep(20)
    s.t.door("stop")
    await run
    expect(s.t.state).toBe("ended")
    expect(s.model.closed).toBe(true)
    expect(s.log.at(-1)).toBe("close")
  })
})

describe("presence look and mode policy", () => {
  it("derives a stable colour and initial, and honours config", () => {
    expect(presenceLook("coder-agent", { name: "Coder" })).toEqual(presenceLook("coder-agent", { name: "Coder" }))
    expect(presenceLook("coder-agent", { name: "Coder" }).initial).toBe("C")
    expect(presenceLook("x", { name: "X", presence: { color: "#112233", initial: "q", allowActions: true } } as any))
      .toMatchObject({ color: "#112233", initial: "Q", allowActions: true })
  })

  const answers = (mode: string, conf: number, next = "click", persist = 0.8) => ({
    mode: { type: "choice", choice: mode, confidence: conf, probabilities: { [mode]: conf } },
    persist: { type: "noul", noul: persist },
    nextAction: { type: "choice", choice: next, confidence: 0.9, probabilities: { [next]: 0.9 } },
  }) as unknown as PresenceModeAnswers

  it("falls back to talk when unsure or undecided, and never acts without permission", () => {
    expect(toPresence(null, true)).toMatchObject({ mode: "talk", override: "no-decision" })
    expect(toPresence(answers("teach", 0.4), true)).toMatchObject({ mode: "talk", override: "low-confidence", probability: 0.4 })
    expect(toPresence(answers("act", 0.9), false)).toMatchObject({ mode: "teach", nextAction: "highlight", override: "actions-not-allowed" })
    expect(toPresence(answers("act", 0.9), true)).toMatchObject({ mode: "act", nextAction: "click", persist: true })
    expect(toPresence(answers("quiet", 0.9, "point", 0.9), true)).toMatchObject({ mode: "quiet", persist: false, nextAction: "speak" })
  })
})
