import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { EventEmitter } from "events"
import Database from "better-sqlite3"
import {
  DEFAULT_TELL_SETTINGS, nagLine, OwnerGate, splitTitle, tellKey, ToldLedger, toldOfBody, type TellSettings,
} from "../src/notify/told"
import { MessageRouter } from "../src/channels/router"
import { digestText } from "../src/approvals/sweep"
import { speakersIn, macosSpeech } from "../src/native/macos/speech"
import { SpeechOut } from "../src/voice/speaking-queue"
import type { Play, Synth } from "../src/voice/speaker"
import { localAlert } from "../src/notify/local"

// #1126 step 2: one record of what the owner was told, told once across
// channels, nags kept for the daily digest, and nothing spoken over
// something already speaking.

const HOUR = 3_600_000
let tmp: string
let db: Database.Database
let clock: number
let settings: TellSettings
let ledger: ToldLedger
let gate: OwnerGate

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-told-"))
  db = new Database(path.join(tmp, "db.sqlite"))
  clock = Date.UTC(2026, 9, 22, 9)
  settings = { ...DEFAULT_TELL_SETTINGS, addresses: ["telegram:42"] }
  ledger = new ToldLedger(db)
  gate = new OwnerGate(ledger, () => settings, () => clock)
})
afterEach(() => {
  db.close()
  rmSync(tmp, { recursive: true, force: true })
})

const push = (title: string, text = "") => ({ channel: "push", chatId: "default", title, text })
const LONG = "The Mac disk is low: 3.1 GB free on the system volume"

describe("what an item is", () => {
  it("is the caller's key, else, for a notice, a long enough text; a request id alone is not one", () => {
    expect(tellKey({ key: "card:abc" }, "t", "x")).toBe("card:abc")
    // "Plan step blocked" and "Plan finished" belong to one request and are two things to tell.
    expect(tellKey({ requestId: "req-1" }, "t", "x")).toBeNull()
    expect(tellKey({ textKey: true }, "Mac disk low", LONG)).toMatch(/^text:[0-9a-f]{24}$/)
    expect(tellKey({ textKey: true }, "Mac disk low", LONG)).toBe(tellKey({ textKey: true }, "Mac  disk low", ` ${LONG.toUpperCase()} `))
    // An agent's answer is never keyed by its words: the same answer twice is two answers.
    expect(tellKey({}, "Mac disk low", LONG)).toBeNull()
    // "Done." twice in a day is two answers, not a repeat.
    expect(tellKey({ textKey: true }, "Secretary", "Done.")).toBeNull()
  })

  it("splits a channel's text into its title line and the rest", () => {
    expect(splitTitle("Title\nbody\nmore")).toEqual({ title: "Title", body: "body\nmore" })
    expect(splitTitle("only")).toEqual({ title: "only", body: "" })
  })
})

describe("the gate", () => {
  it("knows the owner's own addresses: the notification channels and the listed chats", () => {
    expect(gate.isOwnerAddress("push", "default")).toBe(true)
    expect(gate.isOwnerAddress("ntfy", "x")).toBe(true)
    expect(gate.isOwnerAddress("telegram", "42")).toBe(true)
    expect(gate.isOwnerAddress("telegram", "99")).toBe(false)
    settings = { ...settings, enabled: false }
    expect(gate.isOwnerAddress("push", "default")).toBe(false)
  })

  it("tells an item once across channels within the window, and again after it", () => {
    const N = { textKey: true }
    expect(gate.decide(push("Mac disk low", LONG), N).verdict).toBe("send")
    clock += HOUR
    expect(gate.decide({ channel: "telegram", chatId: "42", title: "Mac disk low", text: LONG }, N).verdict).toBe("repeat")
    expect(gate.decide(push("Mac disk low", LONG), N).verdict).toBe("repeat")
    // A text alone is an item for 20 h: a daily report the same words is sent each day.
    clock += 20 * HOUR
    expect(gate.decide(push("Mac disk low", LONG), N).verdict).toBe("send")
    // A named key holds the whole window.
    gate.decide(push("Backups"), { key: "backup" })
    clock += 22 * HOUR
    expect(gate.decide(push("Backups"), { key: "backup" }).verdict).toBe("repeat")
    expect(ledger.counts(0)).toMatchObject({ sent: 3, repeat: 3 })
  })

  it("tells two notices of one request: a request id is not an item", () => {
    expect(gate.decide(push("Plan step blocked: Book the venue"), { requestId: "req-1", textKey: true }).verdict).toBe("send")
    expect(gate.decide(push("Plan finished: Book the venue"), { requestId: "req-1", textKey: true }).verdict).toBe("send")
  })

  it("sends a nag at once when no digest can go out", () => {
    settings = { ...settings, digestAvailable: false }
    expect(gate.decide(push("WhatsApp stopped reconnecting"), { kind: "nag", key: "channel-down:whatsapp" }).verdict).toBe("send")
  })

  it("does not count a send that failed: the item is told again", () => {
    const d = gate.decide(push("x", LONG), { key: "card:1" })
    gate.outcome(d.rowId, "failed")
    expect(gate.decide(push("x", LONG), { key: "card:1" }).verdict).toBe("send")
  })

  it("keeps a nag for the digest, and the same nag again is a repeat", () => {
    const NAG = { requestId: "req-1", kind: "nag" as const, key: "request:req-1:attention" }
    expect(gate.decide(push("Not finished: Check the invoices"), NAG).verdict).toBe("digest")
    expect(gate.decide(push("Not finished: Check the invoices"), NAG).verdict).toBe("repeat")
    expect(ledger.waitingForDigest()).toHaveLength(1)
    expect(ledger.waitingForDigest()[0]).toMatchObject({ requestId: "req-1", kind: "nag", outcome: "digest" })
  })

  it("sends an urgent message whatever was told, and a nag at once when the digest is off", () => {
    gate.decide(push("Call", LONG), { key: "call:1" })
    expect(gate.decide(push("Call", LONG), { key: "call:1", urgent: true }).verdict).toBe("send")
    expect(gate.decide(push("Disk"), { kind: "nag", urgent: true }).verdict).toBe("send")
    settings = { ...settings, digestNags: false }
    expect(gate.decide(push("Disk low"), { kind: "nag", key: "disk" }).verdict).toBe("send")
  })

  it("folds the waiting nags into one digest line and clears them once sent", () => {
    for (const [i, h] of ["Check the invoices", "Compare hosting plans", "Book the venue", "Rename folders"].entries()) {
      gate.decide(push(`Not finished: ${h}`), { requestId: `req-${i}`, kind: "nag" })
    }
    gate.decide(push("Mac disk low"), { kind: "nag", key: "disk" })
    const d = gate.digestLine()!
    expect(d.line).toBe("5 notices held for this digest: Not finished ×4 (Check the invoices, Compare hosting plans, Book the venue, …); Mac disk low.")
    gate.markDigested(d.ids)
    expect(gate.digestLine()).toBeNull()
    expect(digestText([], undefined, d.line)).toContain("5 notices held for this digest")
  })

  it("groups beyond five kinds into a count", () => {
    const rows = ["A", "B", "C", "D", "E", "F", "G"].map((t) => ({ title: t }))
    expect(nagLine(rows)).toMatch(/; 2 more kinds\.$/)
  })

  it("reports counts and rows, and prunes old rows", () => {
    gate.decide(push("one", LONG))
    clock += 100 * 24 * HOUR
    gate.decide(push("two", LONG))
    expect(gate.report(0).counts.sent).toBe(2)
    expect(gate.prune(90)).toBe(1)
    expect(gate.report(0).items.map((r) => r.title)).toEqual(["two"])
  })
})

describe("the daily digest with the nags", () => {
  const SET = { defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 24, notifyAgent: true, digest: { enabled: true, time: "09:00", timezone: "UTC" } }
  const sweep = async (send: (text: string) => Promise<void>) => {
    const { runApprovalsSweep } = await import("../src/approvals/sweep")
    return runApprovalsSweep({
      ctx: { root: tmp, now: clock + 30 * 60_000 }, settings: SET as any, log: () => {},
      fallbackDestination: { channel: "push", chatId: "default" },
      sendDigest: async (_d, text) => send(text),
      nags: { line: () => gate.digestLine(), done: (ids) => gate.markDigested(ids) },
    })
  }

  it("goes out with only nags, says them in one line without '0 decisions', and clears them", async () => {
    gate.decide(push("Not finished: Book the venue"), { kind: "nag", key: "request:r1:attention" })
    const texts: string[] = []
    expect((await sweep(async (t) => { texts.push(t) })).digest).toBe("sent")
    expect(texts[0]).toMatch(/^1 notice held for this digest: Not finished \(Book the venue\)\./)
    expect(texts[0]).not.toContain("0 decisions")
    expect(gate.digestLine()).toBeNull()
  })

  it("keeps the nags waiting when the digest could not be sent", async () => {
    gate.decide(push("Not finished: Book the venue"), { kind: "nag", key: "request:r1:attention" })
    expect((await sweep(async () => { throw new Error("down") })).digest).toBe("failed")
    expect(gate.digestLine()).not.toBeNull()
  })
})

describe("what a /send caller may say", () => {
  it("names the item, the request and the kind, never that it passed the gate", () => {
    // Its key lives in its own space: it cannot silence digest:<day> or a request's notice.
    expect(toldOfBody({ key: " digest:2026-10-22 ", requestId: "req-2", kind: "nag", passed: true, urgent: true, textKey: true }, "cx"))
      .toEqual({ key: "send:digest:2026-10-22", requestId: "req-2", kind: "nag", urgent: true, textKey: true, from: "cx" })
    expect(toldOfBody(undefined)).toEqual({})
    expect(toldOfBody({ kind: "shout" })).toEqual({})
  })
})

describe("the router", () => {
  function router() {
    const sent: string[] = []
    const r = new MessageRouter({ getAgent: () => undefined, refusalFor: () => null } as any, { channels: {} } as any, undefined, () => {})
    for (const name of ["push", "telegram"]) {
      r.addChannel({ name, start: async () => {}, stop: async () => {}, onMessage: () => {}, send: vi.fn(async (m: any) => { sent.push(`${name}:${m.chatId}:${m.text}`); expect(m.told).toBeUndefined() }) } as any)
    }
    r.setOwnerGate(gate)
    return { r, sent }
  }

  it("records every send to the owner's addresses, keeps back repeats and nags, and leaves other chats alone", async () => {
    const { r, sent } = router()
    await r.sendOutbound({ channel: "push", chatId: "default", text: `Mac disk low\n${LONG}`, told: { textKey: true } })
    await r.sendOutbound({ channel: "telegram", chatId: "42", text: `Mac disk low\n${LONG}`, told: { textKey: true } })
    await r.sendOutbound({ channel: "telegram", chatId: "99", text: `Mac disk low\n${LONG}` })
    await r.sendOutbound({ channel: "push", chatId: "default", text: "Disk\nlow", told: { kind: "nag" } })
    expect(sent).toEqual([`push:default:Mac disk low\n${LONG}`, `telegram:99:Mac disk low\n${LONG}`])
    expect(ledger.counts(0)).toMatchObject({ sent: 1, repeat: 1, digest: 1 })
  })

  it("never takes an agent's answer for a repeat: the same answer twice arrives twice", async () => {
    const { r, sent } = router()
    await r.sendOutbound({ channel: "push", chatId: "default", agentId: "secretary", text: `Secretary: ${LONG}` })
    await r.sendOutbound({ channel: "push", chatId: "default", agentId: "secretary", text: `Secretary: ${LONG}` })
    expect(sent).toHaveLength(2)
    expect(ledger.counts(0).sent).toBe(2)
  })

  it("does not decide again for a caller that passed the gate, and records a failed send", async () => {
    const { r, sent } = router()
    await r.sendOutbound({ channel: "push", chatId: "default", text: `T\n${LONG}`, told: { passed: true } })
    expect(sent).toHaveLength(1)
    expect(ledger.counts(0).sent).toBe(0)
    r.addChannel({ name: "ntfy", start: async () => {}, stop: async () => {}, onMessage: () => {}, send: async () => { throw new Error("down") } } as any)
    await expect(r.sendOutbound({ channel: "ntfy", chatId: "default", text: `T2\n${LONG}` })).rejects.toThrow("down")
    expect(ledger.counts(0)).toMatchObject({ failed: 1 })
  })
})

describe("something already speaking", () => {
  const PS = [
    "    1     0 /sbin/launchd",
    "  500     1 /usr/bin/say",
    "  600   777 /usr/bin/afplay",
    "  700   900 /usr/bin/say",
  ].join("\n")

  it("is found in the process list, except the caller's own players", () => {
    expect(speakersIn(PS, [])).toBe("a spoken line (say)")
    expect(speakersIn(PS, [1, 900])).toBe("a sound playing (afplay)")
    expect(speakersIn(PS, [1, 777, 900])).toBeNull()
    expect(speakersIn("garbage\n", [])).toBeNull()
  })

  it("is read from ps on a Mac, and nothing when ps cannot be read", async () => {
    expect(await macosSpeech({ capture: async () => PS }).othersSpeaking({ exceptParents: [1, 777] })).toBe("a spoken line (say)")
    expect(await macosSpeech({ capture: async () => null }).othersSpeaking()).toBeNull()
  })

  it("holds the speaking queue's next line until it stops", async () => {
    const played: string[] = []
    const play: Play = (_f, u) => {
      const p = new EventEmitter() as any
      played.push(u.text)
      setTimeout(() => p.emit("close", 0), 5)
      p.kill = () => p.emit("close", null)
      return p
    }
    const synth: Synth = async () => null
    const speech = new SpeechOut(synth, play, {}, () => 60_000)
    let others: string | null = "a spoken line (say)"
    speech.othersSpeaking = async () => others
    speech.othersPollMs = 10
    const done = speech.say({ text: "Your reply", voice: { provider: "system", elevenlabs: "v", system: null, fallback: true } } as any)
    await new Promise((r) => setTimeout(r, 60))
    expect(played).toEqual([])
    others = null
    expect(await done).toBe(true)
    expect(played).toEqual(["Your reply"])
  })

  it("lets the banner go up at once and the chime wait, or stay silent past the wait", async () => {
    const calls: string[] = []
    const capture = vi.fn(async (file: string) => (file === "/bin/ps" ? "  500     1 /usr/bin/say" : ""))
    const run = vi.fn(async (file: string, args: string[]) => { calls.push(`${file} ${args[0] ?? ""}`); return true })
    const alert = localAlert({ banner: false, sound: true, soundName: "Glass", volume: 0.4, quietWaitSeconds: 0.05 as any },
      { platform: "darwin", run, capture: capture as any, helper: null, pollMs: 10 })
    await alert("t", "m")
    expect(capture).toHaveBeenCalled()
    expect(calls.some((c) => c.includes("afplay"))).toBe(false)
  })
})
