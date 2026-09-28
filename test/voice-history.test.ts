import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import { mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import type Database from "better-sqlite3"
import { openDb, closeDb } from "../src/storage/sqlite"
import type { Play, Synth } from "../src/voice/speaker"
import { SpeechOut } from "../src/voice/speaking-queue"
import {
  ANSWER_PREVIEW_MAX, HISTORY_MAX_LIMIT, QUESTION_PREVIEW_MAX,
  clip, getVoiceExchange, handleVoiceHistory, isVoiceHistoryPath, listVoiceHistory,
} from "../src/daemon/voice-history-api"
import { decideMeshAuth, isMeshGatedPath } from "../src/daemon/mesh-auth"

// #159: the History window reads voice exchanges back from task traces.

let tmp: string
let db: Database.Database
let seq = 0
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0)

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-voice-history-"))
  db = openDb({ path: path.join(tmp, "db.sqlite") })!
})
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })

/** A trace row as /ask leaves it. */
function exchange(o: {
  agent?: string; question?: string; answer?: string | null; at?: number
  channel?: string; chat?: string; status?: string; durationMs?: number; error?: string
} = {}): string {
  const id = `01J${String(++seq).padStart(10, "0")}`
  const agent = o.agent ?? "writer"
  const question = o.question ?? `question ${seq}`
  db.prepare(`
    INSERT INTO task_traces (task_id, agent_id, channel, chat_id, status, started_at, finished_at,
                             duration_ms, message_preview, original_message, final_response, error)
    VALUES (@id, @agent, @channel, @chat, @status, @at, @finished, @duration, @preview, @question, @answer, @error)
  `).run({
    id, agent,
    channel: o.channel ?? "voice",
    chat: o.chat ?? `voice:${agent}`,
    status: o.status ?? "ok",
    at: o.at ?? T0 + seq * 1000,
    finished: (o.at ?? T0 + seq * 1000) + (o.durationMs ?? 4200),
    duration: o.durationMs ?? 4200,
    preview: question.slice(0, 200),
    question,
    answer: o.answer === undefined ? `answer ${seq}` : o.answer,
    error: o.error ?? null,
  })
  return id
}

function fakeSpeech(ms = 30) {
  const played: string[] = []
  const play: Play = (_file, u) => {
    const p = new EventEmitter() as any
    played.push(u.text)
    const t = setTimeout(() => p.emit("close", 0), ms)
    p.kill = () => { clearTimeout(t); p.emit("close", null) }
    return p
  }
  const synth: Synth = async () => null
  return { speech: new SpeechOut(synth, play, {}, () => 60_000), played }
}

const voice = { provider: "system" as const, elevenlabs: "v", system: null, fallback: true }

function deps(speech = fakeSpeech().speech) {
  return {
    db,
    speech,
    voiceOf: (id: string) => (id === "writer" || id === "researcher" ? voice : null),
    speakable: (t: string) => t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim(),
  }
}

describe("GET /voice/history", () => {
  it("lists voice exchanges newest first and leaves other channels out", () => {
    const a = exchange()
    const b = exchange()
    exchange({ channel: "telegram", chat: "123" })
    exchange({ channel: "voice", chat: "workflow:x" })
    const page = listVoiceHistory(db)
    expect(page.ok && page.exchanges.map((e) => e.id)).toEqual([b, a])
    expect(page.ok && page.next).toBeNull()
  })

  it("filtering by one agent shows only its exchanges", () => {
    exchange({ agent: "writer" })
    const r1 = exchange({ agent: "researcher" })
    exchange({ agent: "writer" })
    const r2 = exchange({ agent: "researcher" })
    const reply = handleVoiceHistory(deps(), "GET", "/voice/history", new URLSearchParams("agent=researcher"))
    const body = reply.body as { exchanges: Array<{ id: string; agentId: string }> }
    expect(reply.status).toBe(200)
    expect(body.exchanges.map((e) => e.id)).toEqual([r2, r1])
    expect(new Set(body.exchanges.map((e) => e.agentId))).toEqual(new Set(["researcher"]))
  })

  it("never returns a full answer body, only a capped preview and its length", () => {
    const long = `${"The launch plan has three steps and a long explanation. ".repeat(80)}SECRET-TAIL`
    exchange({ answer: long, question: "q ".repeat(500) })
    const reply = handleVoiceHistory(deps(), "GET", "/voice/history", new URLSearchParams())
    const json = JSON.stringify(reply.body)
    const row = (reply.body as any).exchanges[0]
    expect(json).not.toContain("SECRET-TAIL")
    expect(json.length).toBeLessThan(1_000)
    expect(row.answerPreview.length).toBeLessThanOrEqual(ANSWER_PREVIEW_MAX)
    expect(row.answerPreview.endsWith("…")).toBe(true)
    expect(row.question.length).toBeLessThanOrEqual(QUESTION_PREVIEW_MAX)
    expect(row.answerChars).toBe(long.length)
    expect(row).not.toHaveProperty("answer")
  })

  it("keeps the agentx:ui block out of the preview", () => {
    exchange({ answer: "Here you go.\n\n```agentx:ui\n{\"buttons\":[{\"label\":\"Docs\",\"url\":\"https://example.com\"}]}\n```" })
    const page = listVoiceHistory(db)
    expect(page.ok && page.exchanges[0].answerPreview).toBe("Here you go.")
  })

  it("caps limit at the maximum and defaults a bad one", () => {
    for (let i = 0; i < HISTORY_MAX_LIMIT + 5; i++) exchange()
    const big = listVoiceHistory(db, { limit: "500" })
    expect(big.ok && big.exchanges.length).toBe(HISTORY_MAX_LIMIT)
    const bad = listVoiceHistory(db, { limit: "-3" })
    expect(bad.ok && bad.exchanges.length).toBe(20)
    const three = listVoiceHistory(db, { limit: 3 })
    expect(three.ok && three.exchanges.length).toBe(3)
  })

  it("pages with before, and next is null on the last page", () => {
    const ids = Array.from({ length: 5 }, () => exchange())
    const newest = [...ids].reverse()
    const p1 = listVoiceHistory(db, { limit: 2 })
    expect(p1.ok && p1.exchanges.map((e) => e.id)).toEqual(newest.slice(0, 2))
    const p2 = listVoiceHistory(db, { limit: 2, before: p1.ok ? p1.next : null })
    expect(p2.ok && p2.exchanges.map((e) => e.id)).toEqual(newest.slice(2, 4))
    const p3 = listVoiceHistory(db, { limit: 2, before: p2.ok ? p2.next : null })
    expect(p3.ok && p3.exchanges.map((e) => e.id)).toEqual(newest.slice(4))
    expect(p3.ok && p3.next).toBeNull()
  })

  it("pages through questions asked in the same millisecond without losing or repeating one", () => {
    const at = T0 + 999_000
    const ids = [exchange({ at }), exchange({ at }), exchange({ at })]
    const seen: string[] = []
    let before: string | null = null
    do {
      const page = listVoiceHistory(db, { limit: 1, before })
      if (!page.ok) throw new Error(page.error)
      seen.push(...page.exchanges.map((e) => e.id))
      before = page.next
    } while (before)
    expect(seen.sort()).toEqual([...ids].sort())
  })

  it("takes a time for before, and refuses an unknown id", () => {
    const old = exchange({ at: T0 })
    exchange({ at: T0 + 60_000 })
    const page = listVoiceHistory(db, { before: String(T0 + 1) })
    expect(page.ok && page.exchanges.map((e) => e.id)).toEqual([old])
    const reply = handleVoiceHistory(deps(), "GET", "/voice/history", new URLSearchParams("before=nope"))
    expect(reply.status).toBe(400)
  })

  it("answers 503 without a database", () => {
    const reply = handleVoiceHistory({ ...deps(), db: null }, "GET", "/voice/history", new URLSearchParams())
    expect(reply.status).toBe(503)
  })
})

describe("GET /voice/history/:id", () => {
  it("returns the answer in full, its links and the task page", () => {
    const answer = `Read the guide at https://example.com/guide for details. ${"More. ".repeat(100)}\n\n` +
      "```agentx:ui\n{\"buttons\":[{\"label\":\"Guide\",\"url\":\"https://example.com/guide\"}]}\n```"
    const id = exchange({ agent: "writer", answer })
    const reply = handleVoiceHistory(deps(), "GET", `/voice/history/${id}`, new URLSearchParams())
    const body = reply.body as any
    expect(reply.status).toBe(200)
    expect(body.answer).toContain("https://example.com/guide")
    expect(body.answer).not.toContain("agentx:ui")
    expect(body.answer.length).toBeGreaterThan(ANSWER_PREVIEW_MAX)
    expect(body.ui).toEqual({ buttons: [{ label: "Guide", url: "https://example.com/guide" }] })
    expect(body.taskPath).toBe(`/tasks/${id}?agent=writer&channel=voice`)
    expect(body.durationMs).toBe(4200)
  })

  it("serves only voice rows", () => {
    const other = exchange({ channel: "telegram", chat: "123" })
    expect(getVoiceExchange(db, other)).toBeNull()
    expect(handleVoiceHistory(deps(), "GET", `/voice/history/${other}`, new URLSearchParams()).status).toBe(404)
  })
})

describe("POST /voice/history/:id/replay", () => {
  it("goes through the speaking queue behind the line playing now", async () => {
    const { speech, played } = fakeSpeech(40)
    const id = exchange({ agent: "writer", answer: "The draft is ready, see https://example.com/d" })
    speech.enqueue({ voice, text: "Researcher is speaking", agentId: "researcher", kind: "answer" })
    speech.enqueue({ voice, text: "A line already waiting", agentId: "researcher", kind: "line" })
    const reply = handleVoiceHistory(deps(speech), "POST", `/voice/history/${id}/replay`, new URLSearchParams())
    expect(reply.status).toBe(202)
    const view = speech.view()
    expect(view.playing?.text).toBe("Researcher is speaking")
    expect(view.waiting.map((i) => i.text)).toEqual(["A line already waiting", "The draft is ready, see"])
    await new Promise((r) => setTimeout(r, 200))
    expect(played).toEqual(["Researcher is speaking", "A line already waiting", "The draft is ready, see"])
  })

  it("refuses an exchange without an answer and an agent it cannot voice", () => {
    const empty = exchange({ answer: null, status: "error", error: "boom" })
    expect(handleVoiceHistory(deps(), "POST", `/voice/history/${empty}/replay`, new URLSearchParams()).status).toBe(409)
    const stranger = exchange({ agent: "gone" })
    expect(handleVoiceHistory(deps(), "POST", `/voice/history/${stranger}/replay`, new URLSearchParams()).status).toBe(404)
    expect(handleVoiceHistory(deps(), "GET", `/voice/history/${stranger}/replay`, new URLSearchParams()).status).toBe(405)
  })
})

describe("voice history gate", () => {
  it("every history path is mesh-gated for reads and writes", () => {
    for (const p of ["/voice/history", "/voice/history/01J1", "/voice/history/01J1/replay"]) {
      expect(isVoiceHistoryPath(p)).toBe(true)
      expect(isMeshGatedPath(p)).toBe(true)
    }
    expect(isMeshGatedPath("/voice/historyx")).toBe(false)
  })

  it("loopback reads freely; off-box needs the mesh token", () => {
    const tokens = new Set(["mesh-secret"])
    expect(decideMeshAuth({ remoteAddress: "127.0.0.1", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(true)
    expect(decideMeshAuth({ remoteAddress: "192.0.2.10", authorizationHeader: "", acceptedTokens: tokens }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "192.0.2.10", authorizationHeader: "Bearer wrong", acceptedTokens: tokens }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "192.0.2.10", authorizationHeader: "Bearer mesh-secret", acceptedTokens: tokens }).allowed).toBe(true)
  })

  it("the daemon routes history after the gate", () => {
    const src = readFileSync(path.join(__dirname, "../src/daemon/index.ts"), "utf8")
    const gate = src.indexOf("if (isMeshGatedPath(path))")
    const route = src.indexOf("if (isVoiceHistoryPath(path))")
    expect(gate).toBeGreaterThan(0)
    expect(route).toBeGreaterThan(gate)
  })
})

describe("clip", () => {
  it("cuts at a word and adds an ellipsis", () => {
    expect(clip("short", 10)).toBe("short")
    expect(clip("one two three four", 12)).toBe("one two…")
    expect(clip("a\n\n b", 10)).toBe("a b")
  })
})
