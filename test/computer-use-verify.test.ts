import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { screenStateState } from "../src/decisions/seats/screen-state"

// What is pinned here, and why these parts.
//
// The screen itself cannot be tested: capturing pixels and asking a vision
// model both need a real machine with windows on it, and the model's answer
// is not deterministic anyway. What CAN be pinned is every rule applied
// AROUND the model — which is where this feature's failures actually were.
//
// Each test below is a bug that happened:
//
//   * a verifier that confirmed a false claim, because "I could not tell"
//     was folded into success
//   * a probe that buried a decisive finding under a caveat written for
//     the case where it found nothing
//   * a probe that treated "the app is open" as "the app is recording",
//     which is the exact conflation that started this work

const hoisted = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock("child_process", () => ({ execFile: hoisted.execFileMock }))

/** promisify(execFile) resolves { stdout, stderr }; pgrep exits non-zero
 *  with no match, which promisify surfaces as a rejection. */
function pgrepReturns(byName: Record<string, string>) {
  hoisted.execFileMock.mockImplementation((...call: any[]) => {
    const args = (call[1] ?? []) as string[]
    const cb = call[call.length - 1]
    if (typeof cb !== "function") return
    const pid = byName[args[1]]
    if (pid) cb(null, { stdout: `${pid}\n`, stderr: "" })
    else cb(Object.assign(new Error("no match"), { code: 1 }), { stdout: "", stderr: "" })
  })
}

describe("recording probe", () => {
  beforeEach(() => hoisted.execFileMock.mockReset())
  afterEach(() => vi.resetModules())

  it("treats a live screencapture process as settling the question", async () => {
    // `screencapture -v` exists only while recording, so its presence is
    // the answer and must not be hedged.
    pgrepReturns({ screencapture: "4242" })
    const { probe } = await import("../src/computer-use/probes")
    const [found] = await probe("a screen recording is in progress")

    expect(found.found).toContain("4242")
    expect(found.found).toMatch(/definitely in progress/i)
    // The bug: one hedging paragraph was appended to every outcome,
    // including this one. The seat read the hedge, ignored the pid and
    // answered "cannot tell" with the answer in the same string.
    expect(found.found).not.toMatch(/cannot|neither confirms/i)
  })

  it("refuses to read an open recorder app as a recording in progress", async () => {
    // The Screen Studio case. Its process is running whether or not it is
    // recording, so it is evidence of nothing, and the probe has to say so
    // rather than let the absence of a capture process read as "no".
    pgrepReturns({ "Screen Studio": "40464" })
    const { probe } = await import("../src/computer-use/probes")
    const [found] = await probe("a screen recording is in progress")

    expect(found.found).toContain("Screen Studio")
    expect(found.found).toMatch(/neither confirms nor denies|cannot be verified/i)
    expect(found.found).not.toMatch(/definitely/i)
  })

  it("reports a clean negative when nothing that records is running", async () => {
    pgrepReturns({})
    const { probe } = await import("../src/computer-use/probes")
    const [found] = await probe("is a screen recording happening")

    expect(found.found).toMatch(/No screen-capture process is running/i)
  })

  it("does not fire for claims that have nothing to do with recording", async () => {
    // A seat shown irrelevant facts learns that facts are irrelevant.
    pgrepReturns({ screencapture: "4242" })
    const { probe } = await import("../src/computer-use/probes")
    expect(await probe("the search field contains from:naval")).toEqual([])
  })

  it("ignores processes that merely might touch video", async () => {
    // ffmpeg runs on this machine for unrelated transcoding. An earlier
    // cut listed it and would have "proved" a recording that was not
    // happening.
    pgrepReturns({ ffmpeg: "73347" })
    const { probe } = await import("../src/computer-use/probes")
    const [found] = await probe("a screen recording is in progress")

    expect(found.found).not.toContain("73347")
    expect(found.found).toMatch(/No screen-capture process is running/i)
  })
})

describe("screen-state seat input", () => {
  it("carries the system checks into the state", () => {
    // The seat cannot see the screen. Without these it has only the
    // observation, so a confident wrong description is indistinguishable
    // from a confident right one — measured: it confirmed a false claim
    // about a recording at 76%.
    const state = screenStateState({
      claim: "a screen recording is in progress",
      observation: "a circular icon that is the macOS recording indicator",
      evidence: "hollow circle at the left of the status icons",
      reading: "yes",
      region: "the macOS menu bar",
      probes: [{ checked: "pgrep", found: "No screen-capture process is running." }],
    }) as any

    expect(state.systemChecks).toHaveLength(1)
    expect(state.systemChecks[0].found).toMatch(/No screen-capture process/)
  })

  it("leaves system checks out entirely when there are none", () => {
    const state = screenStateState({
      claim: "the page has loaded",
      observation: "a timeline of posts",
      evidence: "",
      reading: "yes",
      region: "the focused window",
    }) as any
    expect(state.systemChecks).toBeUndefined()
    // An empty string would read as "there was no deciding detail, and
    // here it is" — null says the field is genuinely absent.
    expect(state.decidingDetail).toBeNull()
  })
})
