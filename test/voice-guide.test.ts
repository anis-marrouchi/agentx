import { describe, it, expect, vi, afterEach } from "vitest"
import { CharacterPresence, GuideFeed } from "../src/voice/guide"
import { handleGuide } from "../src/daemon/voice-guide-api"
import { PresenceHost } from "../src/daemon/voice-presence"
import { VoiceTalkService } from "../src/daemon/voice-talk-api"
import { VoiceIntroTracker } from "../src/voice/agent-voice"

const rect = { x: 100, y: 80, width: 90, height: 24 }
const query = (after?: number) => new URLSearchParams(after === undefined ? "" : `after=${after}`)

afterEach(() => vi.useRealTimers())

describe("GuideFeed", () => {
  it("a waiting app gets the next command as soon as it is sent", async () => {
    const feed = new GuideFeed()
    const waiting = feed.next(0)
    expect(feed.listening).toBe(true)
    feed.show("coder-agent", rect, "circle")
    expect(await waiting).toEqual({ seq: 1, agentId: "coder-agent", rect, mark: "circle" })
  })

  it("a command sent between two waits is not lost", async () => {
    const feed = new GuideFeed()
    feed.show(null, rect)
    expect((await feed.next(0)).seq).toBe(1)
  })

  it("with nothing new, the wait ends with the current command", async () => {
    vi.useFakeTimers()
    const feed = new GuideFeed()
    const waiting = feed.next(0, 1000)
    vi.advanceTimersByTime(1000)
    expect(await waiting).toMatchObject({ seq: 0, rect: null })
  })

  it("an app ahead of the feed, after a daemon restart, is sent home at once", async () => {
    expect(await new GuideFeed().next(7)).toMatchObject({ seq: 0, rect: null })
  })

  it("the app counts as there between two waits, and gone soon after its last", async () => {
    let now = 0
    const feed = new GuideFeed(() => now)
    expect(feed.listening).toBe(false)
    feed.show(null, rect)
    await feed.next(0)
    now = 4_000
    expect(feed.listening).toBe(true)
    now = 6_000
    expect(feed.listening).toBe(false)
  })

  it("an app that goes away while it waits no longer counts as there", async () => {
    let now = 0
    const feed = new GuideFeed(() => now)
    const gone = new AbortController()
    const waiting = feed.next(0, 25_000, gone.signal)
    now = 10_000
    expect(feed.listening).toBe(true)
    gone.abort()
    expect(feed.listening).toBe(false)
    expect(await waiting).toMatchObject({ seq: 0 })
  })

  it("a held command goes home by itself, unless a newer one came", () => {
    vi.useFakeTimers()
    const feed = new GuideFeed()
    feed.show(null, rect, "box", 8)
    vi.advanceTimersByTime(8000)
    expect(feed.current).toMatchObject({ seq: 2, rect: null, mark: "none" })

    feed.show(null, rect, "box", 8)
    vi.advanceTimersByTime(4000)
    feed.show(null, { ...rect, x: 300 }, "underline")
    vi.advanceTimersByTime(60_000)
    expect(feed.current).toMatchObject({ seq: 4, rect: { x: 300 }, mark: "underline" })
  })

  it("home is sent once", () => {
    const feed = new GuideFeed()
    expect(feed.home().seq).toBe(0)
    feed.show(null, rect)
    expect(feed.home().seq).toBe(2)
    expect(feed.home().seq).toBe(2)
  })
})

describe("CharacterPresence", () => {
  it("a lesson's steps become commands: go there, mark it, drop the mark, go home", () => {
    const feed = new GuideFeed()
    const p = new CharacterPresence(feed, "coder-agent")
    p.moveTo(rect)
    expect(feed.current).toMatchObject({ seq: 1, rect, mark: "none", agentId: "coder-agent" })
    p.moveTo(rect, { highlight: true })
    expect(feed.current).toMatchObject({ seq: 2, mark: "box" })
    p.say("Press Send")
    expect(feed.current.seq).toBe(2)
    p.clear()
    expect(feed.current).toMatchObject({ seq: 3, rect, mark: "none" })
    p.park()
    expect(feed.current).toMatchObject({ seq: 4, rect: null })
  })

  it("closed, it sends the character home and nothing after", () => {
    const feed = new GuideFeed()
    const p = new CharacterPresence(feed, "coder-agent")
    p.moveTo(rect, { highlight: true })
    p.close()
    expect(feed.current.rect).toBeNull()
    p.moveTo(rect)
    expect(feed.current.rect).toBeNull()
    expect(p.alive).toBe(false)
  })

  it("is alive only while the app waits", async () => {
    let now = 0
    const feed = new GuideFeed(() => now)
    const p = new CharacterPresence(feed, "coder-agent")
    expect(p.alive).toBe(false)
    feed.show(null, rect)
    await feed.next(0)
    expect(p.alive).toBe(true)
    now = 60_000
    expect(p.alive).toBe(false)
  })
})

describe("/voice/guide", () => {
  const listeningFeed = () => {
    const feed = new GuideFeed()
    void feed.next(0, 60_000)
    return feed
  }

  it("refuses when the look is not the character or the app is not there", async () => {
    expect(await handleGuide(listeningFeed(), false, "POST", query(), { rect })).toMatchObject({ status: 409, body: { shown: false } })
    expect(await handleGuide(new GuideFeed(), true, "POST", query(), { rect })).toMatchObject({ status: 409, body: { shown: false } })
  })

  it("sends the character to a rectangle, with a box by default", async () => {
    const feed = listeningFeed()
    const reply = await handleGuide(feed, true, "POST", query(), { rect, agentId: "coder-agent" })
    expect(reply).toMatchObject({ status: 200, body: { shown: true, seq: 1, mark: "box", agentId: "coder-agent" } })
    expect(feed.current.rect).toEqual(rect)
  })

  it("refuses a rectangle with no size, an unknown mark and a hold that is too long", async () => {
    for (const body of [{ rect: { ...rect, width: 0 } }, { rect: { x: 1 } }, {}, { rect, mark: "arrow" }, { rect, hold: 121 }, { rect, hold: 0 }]) {
      expect((await handleGuide(listeningFeed(), true, "POST", query(), body)).status).toBe(400)
    }
  })

  it("sends it home", async () => {
    const feed = listeningFeed()
    await handleGuide(feed, true, "POST", query(), { rect, mark: "underline", hold: 30 })
    expect(await handleGuide(feed, true, "POST", query(), { home: true })).toMatchObject({ status: 200, body: { rect: null } })
  })

  it("GET waits for the command after the one the app has", async () => {
    const feed = new GuideFeed()
    const waiting = handleGuide(feed, true, "GET", query(0), {})
    feed.show(null, rect, "circle")
    expect(await waiting).toMatchObject({ status: 200, body: { seq: 1, mark: "circle" } })
  })
})

describe("a lesson's pointer", () => {
  const agents: any = { "coder-agent": { name: "Coder", systemPrompt: "You are Coder." } }
  it("is the character when the look is the character and the app waits", () => {
    const svc = new VoiceTalkService(() => agents, new VoiceIntroTracker(), () => {}, { voiceSettings: () => ({ look: "character" }) })
    void svc.guide.next(0, 60_000)
    const pointer = (svc.presence as any).lessonPointer("coder-agent")
    pointer.moveTo(rect)
    expect(svc.guide.current).toMatchObject({ rect, agentId: "coder-agent" })
    pointer.close()
    svc.close()
  })

  it("moves the character, and sends it home when the lesson ends", () => {
    const feed = new GuideFeed()
    void feed.next(0, 60_000)
    const host = new PresenceHost(() => agents, () => {}, { character: (id) => new CharacterPresence(feed, id) })
    const pointer = (host as any).lessonPointer("coder-agent")
    pointer.moveTo(rect, { highlight: true })
    expect(feed.current).toMatchObject({ rect, mark: "box" })
    pointer.close()
    expect(feed.current.rect).toBeNull()
    expect(host.onScreen).toEqual([])
  })
})
