import { describe, it, expect } from "vitest"
import { LiveTeach, parsePlan, type ScreenView, type TeachDeps, type TeachMode } from "../src/voice/live-teach"
import { bubbleText, findControl, teachSystemPrompt } from "../src/voice/live-teach-plan"
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
    act: async (s) => { acted.push(s.action === "key" ? `key ${s.keys}` : `${s.action} ${s.label}`); app.open(); return { error: null } },
  }
  if (opts.userActsAfter !== undefined) setTimeout(app.open, opts.userActsAfter)
  const t = new LiveTeach({
    goal: "start a new note", mode, speaker: { name: "Coder", voice: { provider: "system", elevenlabs: "roger", system: null, fallback: true } },
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
    expect(parsePlan("TARGET: none\nACTION: key\nTEXT: shift+.\nSAY: Turn it.", new Set([7])))
      .toEqual({ target: null, action: "key", text: "shift+.", say: "Turn it." })
    expect(parsePlan("TARGET: 99\nACTION: jump\nSAY: Hmm.", new Set([7])))
      .toEqual({ target: null, action: "wait_for_user", text: null, say: "Hmm." })
  })
})

describe("bubbleText", () => {
  it("shows a short target name, a pointer phrase for long ones, nothing without a target", () => {
    expect(bubbleText("Rectangle")).toBe("Rectangle")
    expect(bubbleText("Export as PNG with a transparent background")).toBe("this one")
    expect(bubbleText("")).toBe("this one")
    expect(bubbleText(null)).toBe("")
  })
})

describe("teachSystemPrompt", () => {
  it("asks for short, friend-at-the-keyboard lines and keeps the reply format", () => {
    const p = teachSystemPrompt("You are Coder.", "Anis")
    expect(p).toContain("under thirty words")
    expect(p).toContain("Never end with a yes/no question")
    expect(p).toContain("If Anis asks a question")
    expect(p).toMatch(/^SAY: <what you say>$/m)
  })
})

describe("LiveTeach", () => {
  it("teach: shows and says the step with its own cursor, waits for Anis, never clicks", async () => {
    const s = setup("teach", [STEP1, DONE], { userActsAfter: 40 })
    await s.t.run()
    expect(s.acted).toEqual([])
    expect(s.log).toContain("move 10 highlight")
    // The bubble names the target; the voice carries the sentence.
    expect(s.log).toContain("bubble New")
    expect(s.log).not.toContain("bubble Click New to start a note.")
    // After Anis does the step, the cursor goes back to Anis's pointer.
    expect(s.log.indexOf("park")).toBeGreaterThan(s.log.indexOf("bubble New"))
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

  it("act: clicks while the line is said, and the next line waits for it to end", async () => {
    const s = setup("act", [STEP1, DONE], { actionsAllowed: true, speakMs: 80 })
    const order: string[] = []
    const deps = (s.t as any).deps as TeachDeps
    const speak = deps.speech.say.bind(deps.speech)
    deps.speech.say = async (u: any) => { order.push(`start ${u.text}`); const r = await speak(u); order.push(`end ${u.text}`); return r }
    const act = deps.act
    deps.act = async (a) => { order.push("click"); return act(a) }
    await s.t.run()
    expect(order).toEqual([
      "start Click New to start a note.", "click", "end Click New to start a note.",
      "start There's your note.", "end There's your note.",
    ])
  })

  it("key: presses a shortcut in act mode, and only there", async () => {
    const ROTATE = "TARGET: none\nACTION: key\nTEXT: shift+.\nSAY: Shift and period turns it a little."
    const allowed = setup("act", [ROTATE, DONE], { actionsAllowed: true })
    await allowed.t.run()
    expect(allowed.acted).toEqual(["key shift+."])
    expect(allowed.model.prompts[1]).toContain("you pressed shift+.")

    const teach = setup("teach", [ROTATE, DONE], { userActsAfter: 40 })
    await teach.t.run()
    expect(teach.acted).toEqual([])
    expect(teach.said[0]).toBe("Shift and period turns it a little.")
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

describe("LiveTeach: the screen changes between planning and acting", () => {
  type Btn = { role: string; label: string; x: number }
  /** A screen whose app, window and controls the test changes at will. */
  function screen() {
    const st = { app: "Notes", window: "Welcome", controls: [{ role: "AXButton", label: "New", x: 10 }] as Btn[], reads: 0 }
    const read = async (): Promise<ScreenView> => {
      st.reads++
      const controls = st.controls.map((c, i) => ({ ...c, id: i + 1 }))
      return {
        app: st.app, window: st.window,
        candidates: controls.map(({ id, role, label }) => ({ id, role, label })),
        rectOf: (id) => { const c = controls.find((x) => x.id === id); return c ? { x: c.x, y: 20, width: 60, height: 24 } : null },
      }
    }
    return { st, read }
  }

  /** Runs `change` once the planner has read the screen: the model's
   *  thinking time is when the listener switches windows. */
  function lesson(mode: TeachMode, replies: string[], change: (n: number) => void, opts: { maxReplans?: number } = {}) {
    const s = setup(mode, replies, { actionsAllowed: true })
    const scr = screen()
    const events: any[] = []
    const rects: number[] = []
    const deps = (s.t as any).deps as TeachDeps
    deps.readScreen = scr.read
    deps.act = async (a) => { rects.push(a.rect.x); return { error: null } }
    const reply = s.model.reply.bind(s.model)
    let n = 0
    s.model.reply = (m, sig) => { change(n++); return reply(m, sig) }
    ;(s.t as any).opts.maxReplans = opts.maxReplans
    s.t.on((e) => events.push(e))
    return { ...s, scr, events, rects }
  }

  const HIGHLIGHT = "TARGET: 1\nACTION: highlight\nSAY: That's New."
  const END = "TARGET: none\nACTION: done\nSAY: Done."

  it("a window change throws the plan away and plans again; the stale spot is never shown", async () => {
    const s = lesson("teach", [HIGHLIGHT, HIGHLIGHT, END], (n) => {
      if (n === 0) { s.scr.st.window = "Settings"; s.scr.st.controls = [{ role: "AXButton", label: "New", x: 200 }] }
    })
    await s.t.run()
    const replans = s.events.filter((e) => e.type === "replanned")
    expect(replans).toHaveLength(1)
    expect(replans[0].reason).toContain('"Welcome" to "Settings"')
    expect(s.log.filter((l) => l.startsWith("move"))).toEqual(["move 200 highlight"])
    expect(s.model.prompts[1]).toContain('window "Settings"')
    expect(s.model.prompts[1]).toContain("The screen changed before you acted")
  })

  it("the pointer moving or a tooltip appearing is not a change", async () => {
    const s = lesson("teach", [HIGHLIGHT, END], (n) => {
      if (n === 0) s.scr.st.controls = [{ role: "AXHelpTag", label: "Create a note", x: 400 }, ...s.scr.st.controls]
    })
    await s.t.run()
    expect(s.events.filter((e) => e.type === "replanned")).toEqual([])
    // New's id changed from 1 to 2 with the tooltip; it is still New that is shown.
    expect(s.log.filter((l) => l.startsWith("move"))).toEqual(["move 10 highlight"])
  })

  it("a target that only moved is shown and clicked where it is now", async () => {
    const s = lesson("act", [STEP1, END], (n) => { if (n === 0) s.scr.st.controls[0].x = 50 })
    await s.t.run()
    expect(s.events.filter((e) => e.type === "replanned")).toEqual([])
    expect(s.log).toContain("move 50 highlight")
    expect(s.rects).toEqual([50])
  })

  it("a target that is gone means planning again", async () => {
    const s = lesson("teach", [HIGHLIGHT, END], (n) => { if (n === 0) s.scr.st.controls = [{ role: "AXButton", label: "Open", x: 10 }] })
    await s.t.run()
    expect(s.events.find((e) => e.type === "replanned")?.reason).toBe('"New" is no longer on screen')
    expect(s.log.filter((l) => l.startsWith("move"))).toEqual([])
  })

  it("does not click when the window changed while the step was being said", async () => {
    const s = lesson("act", [STEP1, END], () => {})
    const speak = (s.t as any).deps.speech.say
    ;(s.t as any).deps.speech.say = async (u: any) => { s.scr.st.window = "Other"; return speak(u) }
    await s.t.run()
    expect(s.rects).toEqual([])
    expect(s.events.find((e) => e.type === "replanned")?.reason).toContain('to "Other"')
  })

  it("gives up after too many replans in a row instead of looping", async () => {
    const s = lesson("act", Array(10).fill(STEP1), (n) => { s.scr.st.window = `Window ${n}` }, { maxReplans: 2 })
    await s.t.run()
    expect(s.events.filter((e) => e.type === "replanned")).toHaveLength(3)
    expect(s.events.at(-1)).toEqual({ type: "end", reason: "the screen kept changing" })
    expect(s.rects).toEqual([])
    expect(s.log.filter((l) => l.startsWith("move"))).toEqual([])
  })
})

describe("findControl", () => {
  const view = (cs: Array<[string, string, number]>): ScreenView => ({
    app: "A", window: null,
    candidates: cs.map(([role, label], i) => ({ id: i + 1, role, label })),
    rectOf: (id) => (cs[id - 1] ? { x: cs[id - 1][2], y: 0, width: 1, height: 1 } : null),
  })
  it("finds a control again by role and label, the nearest one when several match", () => {
    const before = view([["AXButton", "Delete", 10], ["AXButton", "Delete", 300]])
    const after = view([["AXStaticText", "Hint", 0], ["AXButton", "Delete", 290], ["AXButton", "Delete", 20]])
    expect(findControl(before, 1, after)).toBe(3)
    expect(findControl(before, 2, after)).toBe(2)
    expect(findControl(before, 1, view([["AXLink", "Delete", 10]]))).toBeNull()
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
