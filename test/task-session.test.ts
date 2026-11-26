import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { TaskSessionIndex, askText, readHead, type LiveRun } from "../src/agents/task-session"
import { JOB_STATE_RULE } from "../src/agents/run-state"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { tsBeforeHtml, tsTimeHtml, tsTurnHtml, tsTurnLabel, tsWhen } from "../src/daemon/ui/pages/wall-task-session"

// #2101 R4: a Task page opened on a follow-up shows its whole chat.

let root: string
function save(agentId: string, id: string, channel: string, chatId: string | undefined, extra: Record<string, unknown> = {}) {
  const ms = Number(id.split("-")[0])
  const startedAt = new Date(ms).toISOString()
  const day = startedAt.slice(0, 10)
  mkdirSync(join(root, agentId, day), { recursive: true })
  // Same shape and key order as registry.persistTaskRecord writes.
  const rec = { id, agentId, channel, ...(chatId ? { chatId } : {}), sender: "Anis", message: "ask " + id, startedAt, endedAt: startedAt, durationMs: 1000, ok: true, responseText: "reply " + id, transcript: "x".repeat(5000), ...extra }
  writeFileSync(join(root, agentId, day, id + ".json"), JSON.stringify(rec, null, 2))
  return rec
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ts-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe("readHead", () => {
  it("reads channel and chatId from the start of a saved record", () => {
    expect(readHead(JSON.stringify({ id: "1", agentId: "a", channel: "a2a", chatId: 'a2a:x:"y"' }, null, 2)))
      .toEqual({ channel: "a2a", chatId: 'a2a:x:"y"' })
    expect(readHead('{"id":"1","channel":"cron"}')).toBeNull()
  })
})

describe("TaskSessionIndex.page", () => {
  it("returns the chat's turns in order, selected included, and nothing from other chats or agents", () => {
    save("a", "1795000000000-aaa", "telegram", "chat-1")
    save("a", "1795000100000-bbb", "telegram", "chat-2") // other chat
    save("a", "1795000200000-ccc", "whatsapp", "chat-1") // same id, other channel
    save("a", "1795086400000-ddd", "telegram", "chat-1") // next day
    save("b", "1795000300000-eee", "telegram", "chat-1") // other agent
    save("a", "1795090000000-fff", "telegram", "chat-1")
    const p = new TaskSessionIndex(root).page("a", "1795086400000-ddd", [])!
    expect(p.session).toEqual({ channel: "telegram", chatId: "chat-1", turns: 3 })
    expect(p.turns.map((t) => [t.id, t.n])).toEqual([["1795000000000-aaa", 1], ["1795086400000-ddd", 2], ["1795090000000-fff", 3]])
    expect(p.turns[0]).toMatchObject({ message: "ask 1795000000000-aaa", responseText: "reply 1795000000000-aaa", sender: "Anis" })
    expect((p.turns[0] as any).transcript).toBeUndefined()
    expect(p.first).toBeNull()
    expect(p.olderBefore).toBeNull()
  })

  it("pages older turns and pins the first request", () => {
    const ids = Array.from({ length: 7 }, (_, i) => `${1795000000000 + i * 1000}-t${i}`)
    ids.forEach((id) => save("a", id, "api", "s"))
    const idx = new TaskSessionIndex(root)
    const p = idx.page("a", ids[5], [], { limit: 2 })!
    expect(p.turns.map((t) => t.n)).toEqual([5, 6, 7]) // 2 up to selected, then up to 2 after
    expect(p.first).toMatchObject({ id: ids[0], n: 1 })
    expect(p.olderBefore).toBe(ids[4])
    const q = idx.page("a", ids[5], [], { limit: 2, before: p.olderBefore })!
    expect(q.turns.map((t) => t.n)).toEqual([3, 4])
    expect(q.olderBefore).toBe(ids[2])
    const r = idx.page("a", ids[5], [], { limit: 2, before: q.olderBefore })!
    expect(r.turns.map((t) => t.n)).toEqual([1, 2])
    expect(r.olderBefore).toBeNull()
    expect(r.first).toBeNull()
  })

  it("adds the running follow-up, which is not saved yet, and records saved after the index was built", () => {
    save("a", "1795000000000-aaa", "a2a", "c")
    const idx = new TaskSessionIndex(root)
    const live: LiveRun[] = [
      { id: "1795000500000-run", channel: "a2a", chatId: "c", message: "and now?", startedAt: new Date(1795000500000) },
      { id: "1795000600000-oth", channel: "a2a", chatId: "other", message: "no", startedAt: new Date(1795000600000) },
    ]
    const p = idx.page("a", "1795000500000-run", live)!
    expect(p.turns.map((t) => [t.id, t.running || false])).toEqual([["1795000000000-aaa", false], ["1795000500000-run", true]])
    const rec = save("a", "1795000700000-new", "a2a", "c")
    idx.note(rec as any)
    expect(idx.page("a", "1795000000000-aaa", [])!.turns.map((t) => t.id)).toEqual(["1795000000000-aaa", "1795000700000-new"])
  })

  it("a run with no chat is a session of one; an unknown run is null", () => {
    save("a", "1795000000000-aaa", "api", undefined)
    const p = new TaskSessionIndex(root).page("a", "1795000000000-aaa", [])!
    expect(p.session).toBeNull()
    expect(p.turns.map((t) => t.id)).toEqual(["1795000000000-aaa"])
    expect(new TaskSessionIndex(root).page("a", "nope", [])).toBeNull()
    expect(new TaskSessionIndex(root).page("../a", "1795000000000-aaa", [])).toBeNull()
  })
})

describe("askText", () => {
  it("shows the typed request, else the message without the job-state rule", () => {
    expect(askText({ message: JOB_STATE_RULE + "Fix the login", requestText: "  fix login " })).toBe("fix login")
    expect(askText({ message: JOB_STATE_RULE + "Fix the login" })).toBe("Fix the login")
    expect(askText({ message: "plain [Job state] text" })).toBe("plain [Job state] text")
  })
})

describe("access", () => {
  it("the session read is mesh-gated: off-box callers need a mesh token", () => {
    expect(isMeshGatedPath("/agents/coder/tasks/1795-x/session")).toBe(true)
  })
})

describe("Task page session HTML", () => {
  const o = { agent: "Coder", href: "#page=task&task=1", md: (s: string) => "<p>" + s.replace(/</g, "&lt;") + "</p>", plain: (s: string) => s, when: () => "today" }
  it("labels where the selected run sits", () => {
    expect(tsTurnLabel(3, 5)).toBe("Follow-up · turn 3 of 5 in this chat")
    expect(tsTurnLabel(1, 2)).toBe("First turn · 1 of 2 in this chat")
    expect(tsTurnLabel(1, 1)).toBe("")
  })
  it("renders a turn's request, reply and log link, escaped", () => {
    const h = tsTurnHtml({ id: 'x"1', n: 2, sender: "<b>Anis</b>", message: "<script>", responseText: "done", ok: true }, o)
    expect(h).toContain('data-turn="x&quot;1"')
    expect(h).toContain("&lt;b&gt;Anis&lt;/b&gt;")
    expect(h).toContain("<p>&lt;script></p>")
    expect(h).toContain("<p>done</p>")
    expect(h).toContain('href="#page=task&amp;task=1">View log</a>')
    expect(tsTurnHtml({ id: "r", message: "q", running: true }, o)).toContain("working now")
    expect(tsTurnHtml({ id: "e", message: "q", ok: false, error: "<boom>" }, o)).toContain("&lt;boom&gt;")
  })
  it("shows the ask's time and the reply's (#2306)", () => {
    const h = tsTurnHtml({ id: "t", message: "q", responseText: "a", ok: true, startedAt: "2026-11-26T10:00:00Z", endedAt: "2026-11-26T10:04:00Z" },
      { ...o, when: (iso: string) => "<time>" + iso.slice(11, 16) + "</time>" })
    expect(h).toContain('<span class="wsess__when"><time>10:00</time></span>')
    expect(h).toContain('<span class="wsess__when"><time>10:04</time></span>')
    expect(tsTurnHtml({ id: "t", message: "q", responseText: "a", ok: true }, o)).not.toContain("today")
  })
  it("pins the first turn and offers older turns", () => {
    const turn = (t: any) => "[" + t.n + "]"
    expect(tsBeforeHtml({ first: { id: "a", n: 1, message: "" }, before: [{ id: "c", n: 3, message: "" }], olderBefore: "c" }, turn))
      .toMatch(/^\[1\]<div class="wsess__gap"><button[^>]*data-session-older="c"[^>]*>Load earlier turns<\/button><\/div>\[3\]$/)
    expect(tsBeforeHtml({ first: null, before: [], olderBefore: null }, turn)).toBe("")
  })
})

describe("tsWhen: a Task page time stamp (#2306)", () => {
  // Built from local parts, so the test holds in any time zone.
  const now = new Date(2026, 10, 26, 18, 30).getTime()
  it("shows HH:MM today", () => {
    expect(tsWhen(new Date(2026, 10, 26, 9, 5).getTime(), now)!.short).toBe("09:05")
    expect(tsWhen(new Date(2026, 10, 26, 0, 0).getTime(), now)!.short).toBe("00:00")
  })
  it("adds the day on another day, and the year in another year", () => {
    expect(tsWhen(new Date(2026, 10, 25, 23, 59).getTime(), now)!.short).toBe("25 Nov 23:59")
    expect(tsWhen(new Date(2025, 10, 26, 14, 2).getTime(), now)!.short).toBe("26 Nov 2025 14:02")
  })
  it("carries the full local time and the ISO form", () => {
    const ms = new Date(2026, 10, 26, 9, 5, 7).getTime()
    const w = tsWhen(ms, now)!
    expect(w.full).toBe(new Date(ms).toLocaleString())
    expect(w.iso).toBe(new Date(ms).toISOString())
  })
  it("shows nothing for no time", () => {
    expect(tsWhen(0, now)).toBeNull()
    expect(tsWhen(NaN, now)).toBeNull()
    expect(tsTimeHtml(0, now)).toBe("")
  })
  it("draws a <time> with datetime and a hover title", () => {
    const ms = new Date(2026, 10, 26, 9, 5).getTime()
    expect(tsTimeHtml(ms, now)).toBe('<time class="ax-time" datetime="' + new Date(ms).toISOString() + '" title="' + new Date(ms).toLocaleString() + '">09:05</time>')
  })
})
