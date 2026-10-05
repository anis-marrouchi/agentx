import { describe, expect, it } from "vitest"
import { FIRST_STEP_MS, formatLesson, gradeLesson, readLessons } from "../src/voice/lesson-log"

// The daemon log of a hands-free lesson, read back and graded against the
// acceptance list of #500. Lines are what VoiceTalkService logs, with the
// daemon's [agentx] tag and the noise around them.

const NEW_BUILD = `
[agentx] [voice] answer (coder-agent) finished after 2.1s, 31 chars
[agentx] [presence] coder-agent seat=presence-mode chose=teach p=0.90 → teach next=none
[agentx] [teach] 2026-10-05T09:00:00.000Z coder-agent (teach): show me how to write a Fibonacci function in Python
[agentx] [teach] 2026-10-05T09:00:07.400Z 1. highlight "New File": Click New File in the sidebar. (screen 120 ms, plan 6200 ms)
[agentx] [door] hush → lesson (coder-agent)
[agentx] [door] "it's not having any effect" → lesson
[agentx] [teach] 2026-10-05T09:00:21.000Z 2. wait_for_user: It's the plus-shaped button, top left. (screen 90 ms, plan 2900 ms)
[agentx] [voice] line (coder-agent) finished after 1.9s, 40 chars
[agentx] [door] hush → lesson (coder-agent)
[agentx] [door] "Okay, stop now." → lesson (ended)
[agentx] [teach] 2026-10-05T09:00:33.000Z ended (stopped by the listener)
[agentx] [door] hush → nothing was speaking
`

const OLD_BUILD = `
[agentx] [presence] coder-agent seat=presence-mode chose=teach p=0.61 → teach next=none
[agentx] [teach] coder-agent (teach): teach me around on VS Code
[agentx] [door] hush → lesson (coder-agent)
[agentx] [teach] ended (stopped by the listener)
[agentx] [door] "show me how to write a Fibonacci in Python" → nothing to take it; the client asks the agent
[agentx] [presence] coder-agent seat=presence-mode chose=teach p=0.90 → teach next=none
[agentx] [teach] coder-agent (teach): show me how to write a Fibonacci in Python
[agentx] [teach] 1. wait_for_user: Create a Python file with Cmd+N.
[agentx] [door] hush → lesson (coder-agent)
[agentx] [teach] ended (stopped by the listener)
`

describe("readLessons", () => {
  it("reads one lesson of a 0.94.0 daemon: start, steps with their times, the words, the stop and the end", () => {
    const [l, ...rest] = readLessons(NEW_BUILD)
    expect(rest).toEqual([])
    expect(l).toMatchObject({
      agentId: "coder-agent", mode: "teach", goal: "show me how to write a Fibonacci function in Python",
      startedBy: { seat: true, chose: "teach", p: 0.9 },
      startedAt: "2026-10-05T09:00:00.000Z", firstStepMs: 7400, hushes: 2, durationMs: 33_000,
      end: { reason: "stopped by the listener", at: "2026-10-05T09:00:33.000Z" },
    })
    expect(l.steps).toEqual([
      { n: 1, action: "highlight", target: "New File", say: "Click New File in the sidebar.", at: "2026-10-05T09:00:07.400Z", readMs: 120, planMs: 6200 },
      { n: 2, action: "wait_for_user", target: null, say: "It's the plus-shaped button, top left.", at: "2026-10-05T09:00:21.000Z", readMs: 90, planMs: 2900 },
    ])
    expect(l.words).toEqual([
      { text: "it's not having any effect", ended: false, afterStep: 1 },
      { text: "Okay, stop now.", ended: true, afterStep: 2 },
    ])
  })

  it("reads the lessons of an older daemon, with no times and no words", () => {
    const lessons = readLessons(OLD_BUILD)
    expect(lessons).toHaveLength(2)
    expect(lessons[0]).toMatchObject({ goal: "teach me around on VS Code", startedBy: { seat: true, p: 0.61 }, startedAt: null, steps: [], hushes: 1, words: [], end: { reason: "stopped by the listener", at: null } })
    expect(lessons[1].steps).toEqual([{ n: 1, action: "wait_for_user", target: null, say: "Create a Python file with Cmd+N.", at: null, readMs: null, planMs: null }])
    expect(lessons[1].firstStepMs).toBeNull()
  })

  it("a lesson from the terminal has no seat line, and one still running has no end", () => {
    const [l] = readLessons(`[agentx] [teach] 2026-10-05T09:00:00.000Z helper (act): open the merge request\n[agentx] [teach] 2026-10-05T09:00:03.000Z 1. click "Open": I'll open it. (screen 60 ms, plan 2500 ms)\n`)
    expect(l.startedBy).toEqual({ seat: false })
    expect(l.end).toBeNull()
    expect(l.durationMs).toBeNull()
  })

  it("a seat line is used once: the next lesson from the terminal does not take it", () => {
    const text = `[agentx] [presence] helper seat=presence-mode chose=teach p=0.80 → teach next=none\n` +
      `[agentx] [teach] 2026-10-05T09:00:00.000Z helper (teach): one\n[agentx] [teach] 2026-10-05T09:00:05.000Z ended (goal reached)\n` +
      `[agentx] [teach] 2026-10-05T09:01:00.000Z helper (teach): two\n`
    expect(readLessons(text).map((l) => l.startedBy.seat)).toEqual([true, false])
  })

  it("door lines before any lesson, and a seat that chose talk, are ignored", () => {
    const text = `[agentx] [door] hush → nothing was speaking\n[agentx] [door] "stop" → speaking queue emptied\n` +
      `[agentx] [presence] helper seat=presence-mode chose=talk p=0.70 → talk next=none\n` +
      `[agentx] [teach] 2026-10-05T09:00:00.000Z helper (teach): one\n`
    const [l] = readLessons(text)
    expect(l.hushes).toBe(0)
    expect(l.words).toEqual([])
    expect(l.startedBy).toEqual({ seat: false })
  })
})

describe("gradeLesson", () => {
  const by = (checks: ReturnType<typeof gradeLesson>) => Object.fromEntries(checks.map((c) => [c.point, c]))

  it("passes the lesson of #500's acceptance list", () => {
    const g = by(gradeLesson(readLessons(NEW_BUILD)[0]))
    expect(g["\"Looking at …\" shows from the start until the first step"]).toMatchObject({ verdict: "by eye", note: "the first step came after 7.4 s" })
    expect(g["Words said mid-lesson pause it and reach the next step"]).toMatchObject({ verdict: "ok", note: `"it's not having any effect": the lesson went on, and a step followed each` })
    expect(g["A spoken stop ends it"]).toMatchObject({ verdict: "ok", note: `"Okay, stop now." ended it (stopped by the listener)` })
    expect(g["[teach] lines carry a time and the screen-read and plan durations"]).toMatchObject({ verdict: "ok", note: "step 1: screen 0.1 s, plan 6.2 s" })
    expect(g["First step under 10.0 s on an idle Mac"]).toMatchObject({ verdict: "ok", note: "7.4 s from the start to step 1" })
    expect(FIRST_STEP_MS).toBe(10_000)
  })

  it("fails the lessons of the issue: no times, a hush that ended them, 40 s to the first step", () => {
    const [first, second] = readLessons(OLD_BUILD).map((l) => by(gradeLesson(l)))
    expect(first["Words said mid-lesson pause it and reach the next step"]).toMatchObject({ verdict: "not ok", note: "a hush ended it: the daemon runs a build older than 0.94.0" })
    expect(first["[teach] lines carry a time and the screen-read and plan durations"]).toMatchObject({ verdict: "not ok" })
    expect(first["First step under 10.0 s on an idle Mac"]).toMatchObject({ verdict: "not seen", note: "no step was logged" })
    expect(first["A spoken stop ends it"]).toMatchObject({ verdict: "not seen", note: "ended another way: stopped by the listener" })
    expect(second["First step under 10.0 s on an idle Mac"]).toMatchObject({ verdict: "not seen", note: "no time on the start or the step line" })

    const slow = readLessons(`[agentx] [teach] 2026-10-05T09:00:00.000Z helper (teach): one\n[agentx] [teach] 2026-10-05T09:00:40.000Z 1. wait_for_user: Create a file. (screen 2100 ms, plan 37000 ms)\n[agentx] [teach] 2026-10-05T09:01:00.000Z ended (stopped)\n`)[0]
    expect(by(gradeLesson(slow))["First step under 10.0 s on an idle Mac"]).toMatchObject({ verdict: "not ok", note: "40.0 s from the start to step 1; a busy Mac or a slow plan model" })
    expect(by(gradeLesson(slow))["A spoken stop ends it"]).toMatchObject({ verdict: "not seen", note: "ended another way: stopped" })
  })

  it("a hush nothing followed, and words no step followed, are told apart", () => {
    const quiet = readLessons(`[agentx] [teach] 2026-10-05T09:00:00.000Z helper (teach): one\n[agentx] [teach] 2026-10-05T09:00:05.000Z 1. point "A": A. (screen 1 ms, plan 2 ms)\n[agentx] [door] hush → lesson (helper)\n[agentx] [teach] 2026-10-05T09:01:06.000Z ended (no words after the hush)\n`)[0]
    expect(by(gradeLesson(quiet))["Words said mid-lesson pause it and reach the next step"]).toMatchObject({ verdict: "not seen", note: "a hush came and nothing was said within a minute, so it ended" })

    const unanswered = readLessons(`[agentx] [teach] 2026-10-05T09:00:00.000Z helper (teach): one\n[agentx] [teach] 2026-10-05T09:00:05.000Z 1. point "A": A. (screen 1 ms, plan 2 ms)\n[agentx] [door] hush → lesson (helper)\n[agentx] [door] "what now" → lesson\n[agentx] [teach] 2026-10-05T09:00:50.000Z ended (Numbers never came to the front)\n`)[0]
    expect(by(gradeLesson(unanswered))["Words said mid-lesson pause it and reach the next step"]).toMatchObject({ verdict: "not ok", note: `"what now": the lesson went on, but no step followed (ended: Numbers never came to the front)` })

    const running = readLessons(`[agentx] [teach] 2026-10-05T09:00:00.000Z helper (teach): one\n[agentx] [door] hush → lesson (helper)\n[agentx] [door] "what now" → lesson\n`)[0]
    expect(by(gradeLesson(running))["Words said mid-lesson pause it and reach the next step"]).toMatchObject({ verdict: "not seen", note: `"what now": the lesson went on, but no step followed yet` })
    expect(by(gradeLesson(running))["A spoken stop ends it"]).toMatchObject({ verdict: "not seen", note: "still running when the log was read, or the daemon stopped" })
  })
})

describe("formatLesson", () => {
  it("prints the lesson, its steps, what was heard, and one line per check", () => {
    const text = formatLesson(readLessons(NEW_BUILD)[0])
    expect(text).toContain(`  2026-10-05T09:00:00Z  coder-agent (teach): "show me how to write a Fibonacci function in Python"`)
    expect(text).toContain("    started by a voice turn: the presence seat chose teach (p=0.90)")
    expect(text).toContain("    2 steps, 2 hushes, ended after 33.0 s (stopped by the listener)")
    expect(text).toContain(`      1. highlight "New File": Click New File in the sidebar. (screen 120 ms, plan 6200 ms)`)
    expect(text).toContain(`      heard "it's not having any effect" → the lesson's next step`)
    expect(text).toContain(`      heard "Okay, stop now." → the lesson ended`)
    expect(text).toContain(`    ok       A spoken stop ends it: "Okay, stop now." ended it (stopped by the listener)`)
    expect(text).toContain(`    by eye   "Looking at …" shows from the start until the first step: the first step came after 7.4 s`)
  })

  it("says when a lesson came from the terminal and has not ended", () => {
    const text = formatLesson(readLessons(`[agentx] [teach] helper (act): open it\n`)[0], (v, t) => `<${v}>${t}`)
    expect(text).toContain("  no time  helper (act): \"open it\"")
    expect(text).toContain("    started by the terminal or the API")
    expect(text).toContain("    0 steps, 0 hushes, no end logged")
    expect(text).toContain("<not ok>not ok   [teach] lines carry a time")
  })
})
