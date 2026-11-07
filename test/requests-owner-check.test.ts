import { describe, it, expect, beforeEach } from "vitest"
import Database from "better-sqlite3"
import { RequestStore } from "../src/requests/store"
import { runRequestsSweep } from "../src/requests/sweep"
import {
  checkCloses, closerWords, DEFAULT_OWNER_CHECK, mismatchReason, ownerCheckPrompt, readOwnerCheck,
  type OwnerCheckSettings,
} from "../src/requests/owner-check"
import type { RequestSettings } from "../src/requests/tracker"

// #1770 — every close records who made it; closes not made by the owner
// are read against the owner's words, and a mismatch opens them again.

const HOUR = 3_600_000
const T0 = 1_800_000_000_000

let store: RequestStore

function open(id: string, text = "Ship the export, then have the tester pass it") {
  store.addCandidate({ id, runId: `run-${id}`, channel: "telegram", chatId: "c1", sender: "owner", agentId: "atlas", text, now: T0 })
  store.progress(id, T0)
}

const ON: OwnerCheckSettings = { ...DEFAULT_OWNER_CHECK, enabled: true }

function deps(answer: string | (() => Promise<string>), settings: OwnerCheckSettings = ON) {
  const prompts: string[] = []
  const logs: string[] = []
  return {
    prompts, logs,
    d: {
      store,
      settings: () => settings,
      generate: async (prompt: string) => {
        prompts.push(prompt)
        return typeof answer === "string" ? answer : answer()
      },
      log: (m: string) => { logs.push(m) },
    },
  }
}

beforeEach(() => {
  store = new RequestStore(new Database(":memory:"))
})

describe("who closed it", () => {
  it("records the closer of every close, and clears it on none", () => {
    open("r1"); open("r2"); open("r3"); open("r4")
    store.close("r1", "declined", "waits on the tester's pass", T0 + 1, null, "atlas")
    store.closeVerified("r2", "the PR merged", T0 + 1)
    store.settle("r3", null, "came back", T0 + 1)
    store.close("r4", "dropped", "no longer wanted", T0 + 1, null, "owner")
    expect(store.get("r1")?.closedBy).toBe("atlas")
    expect(store.get("r2")?.closedBy).toBe("check")
    expect(store.get("r3")?.closedBy).toBe("settle")
    expect(store.get("r4")?.closedBy).toBe("owner")
  })

  it("words each closer for the owner", () => {
    expect(closerWords("owner")).toBe("the owner")
    expect(closerWords("plan")).toMatch(/plan/)
    expect(closerWords("card-expired")).toMatch(/expired/)
    expect(closerWords("atlas")).toBe("agent atlas")
  })
})

describe("reading the model's verdict", () => {
  it("takes match, mismatch and unclear, with a reason", () => {
    expect(readOwnerCheck('{"verdict":"Mismatch","reason":"the owner removed the tester step"}'))
      .toEqual({ verdict: "mismatch", reason: "the owner removed the tester step" })
    expect(readOwnerCheck('sure: {"verdict":"match","reason":"done as asked"}')?.verdict).toBe("match")
    expect(readOwnerCheck('{"verdict":"maybe"}')).toBeNull()
    expect(readOwnerCheck("no json")).toBeNull()
  })

  it("puts the owner's words, the latest note and the close in the prompt, fenced", () => {
    open("r1")
    store.handOff("r1", "atlas", "Skip the tester, just ship it", T0 + 1)
    store.close("r1", "declined", "waits on the tester's pass", T0 + 2, null, "atlas")
    const p = ownerCheckPrompt(store.get("r1")!)
    expect(p).toContain("Ship the export, then have the tester pass it")
    expect(p).toContain("Skip the tester, just ship it")
    expect(p).toContain("declined: waits on the tester's pass")
    expect(p).toContain("by agent atlas")
  })
})

describe("the owner check", () => {
  it("does nothing while off", async () => {
    open("r1")
    store.close("r1", "done", "https://example.com/pr/1", T0 + 1, null, "atlas")
    const { d, prompts } = deps('{"verdict":"mismatch","reason":"x"}', DEFAULT_OWNER_CHECK)
    expect(await checkCloses(d, T0 + 2)).toEqual({ checked: 0, reopened: 0 })
    expect(prompts).toHaveLength(0)
  })

  it("leaves the owner's own closes, closes nobody is named for, and promises", async () => {
    open("r1"); open("r2")
    store.close("r1", "dropped", "no longer wanted", T0 + 1, null, "owner")
    store.close("r2", "done", "https://example.com/pr/2", T0 + 1)
    store.addPromise({ id: "p1", channel: "telegram", chatId: "c1", agentId: "atlas", text: "I'll ship it", owedTo: "owner", now: T0 })
    store.close("p1", "done", "https://example.com/pr/3", T0 + 1, null, "promise")
    const { d, prompts } = deps('{"verdict":"mismatch","reason":"x"}')
    expect(await checkCloses(d, T0 + 2)).toEqual({ checked: 0, reopened: 0 })
    expect(prompts).toHaveLength(0)
  })

  it("keeps a matching close closed, with the verdict", async () => {
    open("r1")
    store.close("r1", "done", "https://example.com/pr/1", T0 + 1, null, "atlas")
    const { d } = deps('{"verdict":"match","reason":"shipped and tested as asked"}')
    expect(await checkCloses(d, T0 + 2)).toEqual({ checked: 1, reopened: 0 })
    const r = store.get("r1")!
    expect(r.state).toBe("done")
    expect(r.ownerCheck).toBe("match")
    expect(r.ownerCheckDetail).toBe("shipped and tested as asked")
  })

  it("opens a mismatch again as needing attention, with the reason, and reads each close once", async () => {
    open("r1")
    store.handOff("r1", "atlas", "Drop the tester step", T0 + 1)
    store.close("r1", "declined", "waits on the tester's pass", T0 + 2, null, "atlas")
    const { d, prompts } = deps('{"verdict":"mismatch","reason":"the owner removed the tester step"}')
    expect(await checkCloses(d, T0 + 3)).toEqual({ checked: 1, reopened: 1 })
    const r = store.get("r1")!
    expect(r.state).toBe("needs_attention")
    expect(r.closedAt).toBeNull()
    expect(r.closedBy).toBe("atlas")
    expect(r.ownerCheck).toBe("mismatch")
    expect(r.attentionReason).toBe(mismatchReason({ closedBy: "atlas", state: "declined" }, "the owner removed the tester step"))
    expect(r.notifiedAt).toBeNull()
    // Not read again.
    expect(await checkCloses(d, T0 + 4)).toEqual({ checked: 0, reopened: 0 })
    expect(prompts).toHaveLength(1)
    // A new close is a new one to read.
    store.close("r1", "done", "https://example.com/pr/9", T0 + 5, null, "atlas")
    expect(store.get("r1")?.ownerCheck).toBeNull()
    expect((await checkCloses(d, T0 + 6)).checked).toBe(1)
  })

  it("keeps unclear closes closed, and records a call that failed without reopening", async () => {
    open("r1"); open("r2")
    store.close("r1", "done", "https://example.com/pr/1", T0 + 1, null, "plan")
    store.close("r2", "done", "https://example.com/pr/2", T0 + 1, null, "workflow")
    let n = 0
    const { d } = deps(async () => {
      if (n++ === 0) return '{"verdict":"unclear","reason":"cannot tell"}'
      throw new Error("not signed in")
    })
    expect(await checkCloses(d, T0 + 2)).toEqual({ checked: 2, reopened: 0 })
    const states = ["r1", "r2"].map((id) => store.get(id)!)
    expect(states.every((r) => r.state === "done")).toBe(true)
    expect(states.map((r) => r.ownerCheck).sort()).toEqual([null, "unclear"].sort())
    expect(states.find((r) => r.ownerCheck === null)?.ownerCheckDetail).toMatch(/not read: not signed in/)
  })

  it("reads only recent closes, up to perCheck", async () => {
    open("old"); open("a"); open("b")
    store.close("old", "done", "https://example.com/1", T0, null, "atlas")
    store.close("a", "done", "https://example.com/2", T0 + 30 * HOUR, null, "atlas")
    store.close("b", "done", "https://example.com/3", T0 + 30 * HOUR, null, "atlas")
    const { d } = deps('{"verdict":"match","reason":"ok"}', { ...ON, perCheck: 1 })
    expect((await checkCloses(d, T0 + 31 * HOUR)).checked).toBe(1)
    expect((await checkCloses(d, T0 + 31 * HOUR)).checked).toBe(1)
    expect((await checkCloses(d, T0 + 31 * HOUR)).checked).toBe(0)
    expect(store.get("old")?.ownerCheckedAt).toBeNull()
  })

  it("leaves a close the owner changed while it was read", async () => {
    open("r1")
    store.close("r1", "declined", "not now", T0 + 1, null, "atlas")
    const { d } = deps(async () => {
      store.reopen("r1", "do it now", T0 + 2)
      return '{"verdict":"mismatch","reason":"x"}'
    })
    expect(await checkCloses(d, T0 + 3)).toEqual({ checked: 1, reopened: 0 })
    expect(store.get("r1")?.state).toBe("in_progress")
  })
})

describe("in the requests check", () => {
  it("tells the owner once about a close it opened again", async () => {
    const settings: RequestSettings = { enabled: true, channels: [], from: [], staleAfterHours: 24, retentionDays: 90 }
    open("r1")
    store.close("r1", "declined", "waits on the tester's pass", T0 + 1, null, "atlas")
    const { d } = deps('{"verdict":"mismatch","reason":"the owner removed the tester step"}')
    const told: Array<{ title: string; message: string }> = []
    const sweep = () => runRequestsSweep({
      store, settings, now: T0 + 2, log: () => {},
      checkCloses: (now) => checkCloses(d, now),
      notify: async (title, message) => { told.push({ title, message }) },
    })
    const first = await sweep()
    expect(first.reopened).toBe(1)
    expect(first.notified).toBe(1)
    expect(told[0].message).toContain("does not match what you asked")
    await sweep()
    expect(told).toHaveLength(1)
  })
})
