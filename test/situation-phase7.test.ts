import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SituationStore } from "../src/situations/store"
import { DEFAULT_SITUATIONS_CONFIG, situationsConfigSchema, type SituationsConfig } from "../src/situations/config"
import { attachSignalSources, sourcesView, type AttachedSources } from "../src/situations/sources/node"
import { SignalSources } from "../src/situations/sources/registry"
import { SourceReadLog } from "../src/situations/sources/read-log"
import { cardConsent, consentMinutes, consentState, quotedWhy } from "../src/situations/sources/consent"
import { sourcesAsk, sourcesRead, sourcesReads, sourcesTurnFrom, type SourcesTurn } from "../src/situations/sources/request-api"
import { bareAddress, browserTabsSource, feedHeadlines, newsSource, openAppsSource, type RunScript } from "../src/situations/sources/per-request"
import { isUnknown, type Signal } from "../src/situations/sources/types"
import { decideCard, listCards, readCard, saveCard, verdictMessage, POPUP_ONLY } from "../src/approvals/cards"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import { listedTools } from "../src/mcp/index"
import { AGENTX_TOOL_NAMES, READ_TOOL_NAMES } from "../src/mcp/tool-names"
import { sourcesToolOn } from "../src/situations/sources-tool"

// #1892 phase 7: per-request sources (open apps, browser tabs, news) with
// the person's yes, which expires. Owner's answer Q3 (2026-11-18): off by
// default, read only per request, and only after the person says yes,
// with an expiry. Proof of done (design 9): with consent off, the read log
// is empty; with consent on, each read has a log row. Neutral ids only.

const AGENT = "helper"
const OTHER = "writer"
const TASK = "task-0001"

let root: string
let db: Database.Database
let log: SourceReadLog
let attached: AttachedSources | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentx-1892p7-"))
  db = new Database(":memory:")
  log = new SourceReadLog(db)
})

afterEach(() => {
  attached?.detach()
  attached = null
  db.close()
  rmSync(root, { recursive: true, force: true })
})

/** The fake Mac: what AppleScript would answer. Counts each script run,
 *  which is a read of the person's screen. */
function fakeMac() {
  const run = vi.fn<RunScript>(async (script) => {
    if (script.includes("System Events")) return "Notes\nShopping list\nNotes\nMail\nCalendar\n"
    if (script.includes("Google Chrome")) return "Docs home\thttps://docs.example.com/start?session=abc123#top\nTracker\thttps://tracker.example.org/board\n"
    return ""
  })
  return run
}

function settingsWith(sources: SituationsConfig["sources"], over: Partial<SituationsConfig> = {}): SituationsConfig {
  return situationsConfigSchema.parse({ ...DEFAULT_SITUATIONS_CONFIG, ...over, sources })
}

function attach(settings: () => SituationsConfig, run: RunScript, fetchText?: (u: string) => Promise<string>): AttachedSources {
  attached = attachSignalSources({
    store: new SituationStore(db),
    settings,
    calls: () => undefined,
    consent: cardConsent(root),
    readLog: log,
    runScript: run,
    ...(fetchText ? { fetchText } : {}),
    platform: "darwin",
  })
  return attached
}

const TURN: SourcesTurn = { agentId: AGENT, taskId: TASK, reply: { channel: "telegram", chatId: "100" } }
const CONSENT = { askMinutes: 60, defaultMinutes: 15, maxMinutes: 60 }

function ask(sources: SignalSources, body: Record<string, unknown>, over: Partial<Parameters<typeof sourcesAsk>[1]> = {}) {
  return sourcesAsk(body, { local: true, turn: TURN, sources, root, settings: CONSENT, popupOn: true, ...over })
}

function read(sources: SignalSources, body: Record<string, unknown>, over: Partial<Parameters<typeof sourcesRead>[1]> = {}) {
  return sourcesRead(body, { local: true, turn: TURN, sources, root, ...over })
}

describe("settings: new features default off", () => {
  it("no per-request source is on, and the yes is short by default", () => {
    const d = DEFAULT_SITUATIONS_CONFIG
    expect(d.sources).toEqual({})
    expect(d.consent).toEqual({ askMinutes: 60, defaultMinutes: 15, maxMinutes: 60 })
    expect(d.news).toEqual({ feeds: [], maxItems: 10, timeoutMs: 8000 })
    expect(sourcesToolOn(d.sources)).toBe(false)
    expect(sourcesToolOn({ "browser-tabs": { enabled: true } })).toBe(true)
    // Only http(s) feeds.
    expect(() => situationsConfigSchema.parse({ news: { feeds: ["file:///etc/passwd"] } })).toThrow()
  })

  it("the agentx_sources tool is listed only while a per-request source is on", () => {
    expect(AGENTX_TOOL_NAMES).toContain("agentx_sources")
    expect(READ_TOOL_NAMES).not.toContain("agentx_sources")
    expect(listedTools({}, "full").map((t) => t.name)).not.toContain("agentx_sources")
    expect(listedTools({ AGENTX_SOURCES_TOOL: "1" }, "full").map((t) => t.name)).toContain("agentx_sources")
  })

  it("the new routes are mesh-gated", () => {
    expect(isMeshGatedPath("/situations/sources/ask")).toBe(true)
    expect(isMeshGatedPath("/situations/sources/read")).toBe(true)
    expect(isMeshGatedPath("/situations/sources/reads")).toBe(true)
  })
})

describe("a per-request source is never read on its own", () => {
  it("off unless switched on: nothing read, no row", async () => {
    const run = fakeMac()
    const a = attach(() => DEFAULT_SITUATIONS_CONFIG, run)
    const [s] = await a.sources.readForRequest("news", { agentId: AGENT, requestId: TASK })
    expect(isUnknown(s)).toBe(true)
    expect(s.reason).toMatch(/situations\.sources\.news\.enabled/)
    const r = await read(a.sources, { source: "browser-tabs", request: "2026-01-01-x-abcd" })
    expect((r.body.answers as Signal[])[0].value).toBe("unknown")
    expect(run).not.toHaveBeenCalled()
    expect(log.list()).toEqual([])
  })

  it("the sync read path, the sources view and pushed signals never touch it", async () => {
    const run = fakeMac()
    const a = attach(() => settingsWith({ "open-apps": { enabled: true }, news: { enabled: true } }), run)
    expect(isUnknown(a.sources.read("open-apps", { agentId: AGENT, requestId: "x" })[0])).toBe(true)
    const view = sourcesView(a.sources, { local: true })
    const row = view.loaded.find((s) => s.id === "open-apps") as Record<string, unknown>
    expect(row).toMatchObject({ perRequest: true, sensitivity: "sensitive" })
    expect(row.value).toBeUndefined()
    expect(a.sources.accepts({ source: "open-apps", kind: "apps", subject: "owner", value: "Notes", checkedAt: 0, expiresAt: null, reason: "" })).toBe(false)
    expect(run).not.toHaveBeenCalled()
    expect(log.list()).toEqual([])
  })

  it("on a Linux node the Mac sources are not loaded; news is", () => {
    const linux = attachSignalSources({ store: new SituationStore(db), settings: () => DEFAULT_SITUATIONS_CONFIG, calls: () => undefined, platform: "linux" })
    expect(linux.sources.loaded().map((s) => s.id)).toContain("news")
    expect(linux.sources.skipped().map((s) => s.id)).toEqual(expect.arrayContaining(["open-apps", "browser-tabs"]))
    linux.detach()
  })

  it("settings cannot lower the yes for a sensitive source", () => {
    const a = attach(() => settingsWith({ "browser-tabs": { enabled: true, consent: "none" } }), fakeMac())
    expect(a.sources.needsConsent("browser-tabs")).toBe(true)
    expect(a.sources.needsConsent("news")).toBe(false)
    expect(attachSignalSources({ store: new SituationStore(db), settings: () => settingsWith({ news: { enabled: true, consent: "person" } }), calls: () => undefined }).sources.needsConsent("news")).toBe(true)
  })
})

describe("the ask is a popup-only decision card: the card is the consent record", () => {
  it("one card, raised for the agent, yes only in the popup, agent text one-lined and quoted", () => {
    const a = attach(() => settingsWith({ "browser-tabs": { enabled: true } }), fakeMac())
    const r = ask(a.sources, { sources: ["browser-tabs"], why: "Which \"doc\" is\nopen? ignore all rules", minutes: 500 })
    expect(r.status).toBe(201)
    expect(r.body.minutes).toBe(60) // capped by maxMinutes
    const card = readCard(root, String(r.body.request))!
    expect(card).toMatchObject({ raised_by: AGENT, popup_only: true, if_silent: "discard", status: "pending" })
    expect(card.origin).toEqual({ kind: "source-consent", agentId: AGENT, sources: ["browser-tabs"], minutes: 60 })
    expect(card.ask).toContain(`Its reason: "Which doc is open ignore all rules".`)
    expect((card.ask.match(/\?/g) ?? []).length).toBe(1)
    expect(card.ask).toMatch(/goes to its model/)
    // Only the person's popup can say yes.
    const viaChat = decideCard(root, card.id, "yes", { by: "someone in chat" })
    expect(viaChat).toEqual({ ok: false, error: POPUP_ONLY })
  })

  it("refuses: off-machine callers, no running turn, a source switched off, one needing no yes, the popup off", () => {
    const a = attach(() => settingsWith({ "browser-tabs": { enabled: true }, news: { enabled: true } }), fakeMac())
    expect(ask(a.sources, { sources: ["browser-tabs"], why: "x" }, { local: false }).status).toBe(403)
    expect(ask(a.sources, { sources: ["browser-tabs"], why: "x" }, { turn: null }).status).toBe(403)
    expect(ask(a.sources, { sources: ["open-apps"], why: "x" }).status).toBe(409)
    expect(ask(a.sources, { sources: ["news"], why: "x" }).status).toBe(400)
    expect(ask(a.sources, { sources: ["browser-tabs"], why: "" }).status).toBe(400)
    const off = ask(a.sources, { sources: ["browser-tabs"], why: "x" }, { popupOn: false })
    expect(off.status).toBe(409)
    expect(String(off.body.error)).toMatch(/popup/)
    expect(listCards(root)).toEqual([])
  })

  it("the agent is told the answer and how long the yes lasts", () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const id = String(ask(a.sources, { sources: ["open-apps"], why: "check the front app" }).body.request)
    const yes = decideCard(root, id, "yes", { popup: true, by: "operator (popup)", now: Date.parse("2030-01-01T10:00:00Z") })
    expect(yes.ok).toBe(true)
    const msg = verdictMessage(readCard(root, id)!)
    expect(msg).toContain(`request "${id}"`)
    expect(msg).toContain("until 2030-01-01T10:15:00.000Z")
    const id2 = String(ask(a.sources, { sources: ["open-apps"], why: "again" }).body.request)
    decideCard(root, id2, "no", { by: "operator (chat)" })
    expect(verdictMessage(readCard(root, id2)!)).toMatch(/Nothing will be read/)
  })

  it("every doubt is a no", () => {
    const now = Date.parse("2030-01-01T10:05:00Z")
    const base = {
      id: "2030-01-01-c-aaaa", title: "t", ask: "a", recommend: "r", if_silent: "discard" as const, expires: "2030-01-02T00:00:00Z",
      raised_by: AGENT, created_at: "2030-01-01T09:00:00Z", popup_only: true as const, status: "decided" as const, verdict: "yes" as const,
      decided_from: "popup" as const, decided_at: "2030-01-01T10:00:00Z",
      origin: { kind: "source-consent" as const, agentId: AGENT, sources: ["browser-tabs"], minutes: 15 },
    }
    expect(consentState(base, "browser-tabs", AGENT, now)).toEqual({ granted: true, until: Date.parse("2030-01-01T10:15:00Z") })
    expect(consentState(base, "browser-tabs", AGENT, Date.parse("2030-01-01T10:15:00Z")).granted).toBe(false) // expired
    expect(consentState(base, "open-apps", AGENT, now).granted).toBe(false) // not asked for
    expect(consentState(base, "browser-tabs", OTHER, now).granted).toBe(false) // another agent
    expect(consentState(base, "browser-tabs", undefined, now).granted).toBe(false)
    expect(consentState({ ...base, decided_from: undefined }, "browser-tabs", AGENT, now).granted).toBe(false) // not from the popup
    expect(consentState({ ...base, popup_only: undefined }, "browser-tabs", AGENT, now).granted).toBe(false)
    expect(consentState({ ...base, node: "elsewhere" }, "browser-tabs", AGENT, now).granted).toBe(false)
    expect(consentState({ ...base, status: "pending" }, "browser-tabs", AGENT, now).granted).toBe(false)
    expect(consentState({ ...base, verdict: "no" }, "browser-tabs", AGENT, now).granted).toBe(false)
    expect(consentState({ ...base, origin: undefined }, "browser-tabs", AGENT, now).granted).toBe(false)
    expect(consentState({ ...base, origin: { ...base.origin, minutes: 0 } }, "browser-tabs", AGENT, now).granted).toBe(false)
    expect(consentState(null, "browser-tabs", AGENT, now).granted).toBe(false)
    // A card id that is no card file, or a path trick, is a no.
    expect(cardConsent(root)("browser-tabs", { agentId: AGENT, requestId: "../../etc/passwd" }, now)).toBe(false)
    expect(cardConsent(root)("browser-tabs", { agentId: AGENT }, now)).toBe(false)
  })

  it("minutes and the quoted reason stay in bounds", () => {
    expect(consentMinutes(undefined, CONSENT)).toBe(15)
    expect(consentMinutes(0, CONSENT)).toBe(1)
    expect(consentMinutes(10_000, { ...CONSENT, maxMinutes: 100_000 })).toBe(24 * 60)
    expect(quotedWhy("a\n\n\"b\"?")).toBe("a b")
    expect(quotedWhy("x".repeat(500)).length).toBe(120)
  })
})

describe("proof of done (design 9, phase 7)", () => {
  it("with consent off the read log is empty; with consent on each read has a log row", async () => {
    const run = fakeMac()
    const a = attach(() => settingsWith({ "browser-tabs": { enabled: true }, "open-apps": { enabled: true } }), run)

    // --- Consent off ---
    // No ask at all: a read with a made-up request.
    let r = await read(a.sources, { source: "browser-tabs", request: "2030-01-01-made-up-abcd" })
    expect(r.status).toBe(200)
    expect((r.body.answers as Signal[]).every((s) => s.value === "unknown")).toBe(true)
    // No request at all.
    expect((await read(a.sources, { source: "browser-tabs" })).status).toBe(400)
    // Asked, not answered yet.
    const id = String(ask(a.sources, { sources: ["browser-tabs", "open-apps"], why: "find the open draft" }).body.request)
    r = await read(a.sources, { source: "browser-tabs", request: id })
    expect(r.body.consent).toBe("waiting for the person's answer")
    // An agent's or a chat's yes does not count.
    expect(decideCard(root, id, "yes", { by: AGENT }).ok).toBe(false)
    r = await read(a.sources, { source: "open-apps", request: id })
    expect((r.body.answers as Signal[])[0].value).toBe("unknown")
    // A card file edited to say yes without the popup does not count.
    saveCard(root, { ...readCard(root, id)!, status: "decided", verdict: "yes", decided_at: new Date().toISOString() })
    r = await read(a.sources, { source: "browser-tabs", request: id })
    expect(r.body.consent).toBe("the yes did not come from the popup")
    // The person said no.
    const noId = String(ask(a.sources, { sources: ["browser-tabs"], why: "again" }).body.request)
    decideCard(root, noId, "no", { popup: true })
    r = await read(a.sources, { source: "browser-tabs", request: noId })
    expect(r.body.consent).toBe("the person did not say yes")
    expect(run).not.toHaveBeenCalled()
    expect(log.list()).toEqual([])

    // --- Consent on ---
    const yesId = String(ask(a.sources, { sources: ["browser-tabs", "open-apps"], why: "find the open draft", minutes: 15 }).body.request)
    expect(decideCard(root, yesId, "yes", { popup: true, by: "operator (popup)" }).ok).toBe(true)
    r = await read(a.sources, { source: "browser-tabs", request: yesId })
    const tabs = String((r.body.answers as Signal[])[0].value)
    expect(tabs).toContain("Google Chrome: Docs home (https://docs.example.com/start)")
    expect(tabs).not.toContain("session=abc123") // no query strings
    r = await read(a.sources, { source: "open-apps", request: yesId })
    expect((r.body.answers as Array<{ kind: string; value: unknown }>).find((s) => s.kind === "front-app")?.value).toBe("Notes")
    r = await read(a.sources, { source: "browser-tabs", request: yesId })
    expect(run).toHaveBeenCalled()

    const rows = log.list()
    expect(rows).toHaveLength(3)
    expect(rows.map((x) => x.source).sort()).toEqual(["browser-tabs", "browser-tabs", "open-apps"])
    for (const row of rows) expect(row).toMatchObject({ agentId: AGENT, requestId: yesId, outcome: "read" })
    // The log holds when, who, which source and request: never what was read.
    expect(JSON.stringify(rows)).not.toMatch(/Docs home|docs\.example|Notes|Shopping/)

    // Another agent cannot use that yes.
    r = await read(a.sources, { source: "browser-tabs", request: yesId }, { turn: { agentId: OTHER, taskId: "task-0002" } })
    expect(r.body.consent).toBe("asked by another agent")
    expect(log.list()).toHaveLength(3)
  })

  it("the yes ends by itself: after it, no read and no row", async () => {
    const run = fakeMac()
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), run)
    const id = String(ask(a.sources, { sources: ["open-apps"], why: "front app", minutes: 15 }).body.request)
    decideCard(root, id, "yes", { popup: true, now: Date.now() - 16 * 60_000 })
    const r = await read(a.sources, { source: "open-apps", request: id })
    expect(String(r.body.consent)).toMatch(/^the yes ended at /)
    expect(run).not.toHaveBeenCalled()
    expect(log.list()).toEqual([])
  })

  it("news needs no yes, but is still read only per request and logged", async () => {
    const get = vi.fn(async () => `<rss><channel><item><title>Rain &amp; wind today</title><link>https://news.example.com/a?ref=x</link></item></channel></rss>`)
    const a = attach(() => settingsWith({ news: { enabled: true } }, { news: { feeds: ["https://news.example.com/feed"], maxItems: 5, timeoutMs: 1000 } }), fakeMac(), get)
    const r = await read(a.sources, { source: "news" })
    expect((r.body.answers as Signal[])[0].value).toBe("Rain & wind today (https://news.example.com/a)")
    expect(log.list()).toMatchObject([{ source: "news", agentId: AGENT, requestId: TASK, outcome: "read", count: 1 }])
    // Not for an agent the source is limited away from.
    const b = attach(() => settingsWith({ news: { enabled: true, agents: [OTHER] } }, { news: { feeds: ["https://news.example.com/feed"], maxItems: 5, timeoutMs: 1000 } }), fakeMac(), get)
    expect(((await read(b.sources, { source: "news" })).body.answers as Signal[])[0].reason).toBe("off for this agent")
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("a read log that cannot be written means no read (fail closed)", async () => {
    const run = fakeMac()
    const broken = { start: () => { throw new Error("disk full") }, finish: () => {} }
    const sources = new SignalSources({ platform: "darwin", settings: () => ({ "open-apps": { enabled: true } }), consent: () => true, readLog: broken })
    sources.register(openAppsSource(run))
    const [s] = await sources.readForRequest("open-apps", { agentId: AGENT, requestId: "r1" })
    expect(s.reason).toMatch(/read log could not be written/)
    expect(run).not.toHaveBeenCalled()
    const none = new SignalSources({ platform: "darwin", settings: () => ({ "open-apps": { enabled: true } }), consent: () => true })
    none.register(openAppsSource(run))
    expect((await none.readForRequest("open-apps", { agentId: AGENT, requestId: "r1" }))[0].reason).toMatch(/no read log/)
    expect(run).not.toHaveBeenCalled()
  })

  it("the read routes answer this machine only, and only a running turn", async () => {
    const a = attach(() => settingsWith({ news: { enabled: true } }), fakeMac())
    expect((await read(a.sources, { source: "news" }, { local: false })).status).toBe(403)
    expect((await read(a.sources, { source: "news" }, { turn: null })).status).toBe(403)
    expect(sourcesReads(new URLSearchParams(), { local: false, log }).status).toBe(403)
    expect(sourcesReads(new URLSearchParams(), { local: true, log }).body).toEqual({ reads: [] })
  })
})

describe("the turn comes from the proof, never the body", () => {
  const deps = {
    taskOwner: (id: string) => (id === TASK ? AGENT : null),
    findRunningTurn: (agentId: string, by: { taskId?: string; channel?: string; chatId?: string }) =>
      agentId === AGENT && (by.taskId === TASK || (by.channel === "telegram" && by.chatId === "100"))
        ? { taskId: TASK, context: { channel: "telegram", chatId: "100" } } : null,
  }
  it("a task proof names its owner; a body's agent id is ignored", () => {
    expect(sourcesTurnFrom({ taskId: TASK }, OTHER, deps)).toMatchObject({ agentId: AGENT, taskId: TASK, reply: { channel: "telegram", chatId: "100" } })
    expect(sourcesTurnFrom({ taskId: "task-x" }, AGENT, deps)).toBeNull()
    expect(sourcesTurnFrom({}, AGENT, deps)).toBeNull()
    // A warm process: chat proof plus the claimed agent, checked against a running turn.
    expect(sourcesTurnFrom({ channel: "telegram", chatId: "100" }, OTHER, deps)).toBeNull()
    expect(sourcesTurnFrom({ channel: "telegram", chatId: "100" }, AGENT, deps)?.agentId).toBe(AGENT)
  })
})

describe("adapters", () => {
  it("open apps: front app, window title, open apps; unknown parts say why", async () => {
    const out = await openAppsSource(async () => "Notes\n\nNotes\nMail\n").readAsync!({})
    expect(out.map((s) => [s.kind, s.value])).toEqual([["front-app", "Notes"], ["front-window", "unknown"], ["open-apps", "Notes, Mail"]])
    expect(out[1].reason).toMatch(/Accessibility/)
  })

  it("browser tabs: one browser down does not stop the other; no query or fragment", async () => {
    const run: RunScript = async (script) => {
      if (script.includes("Safari")) throw new Error("not allowed")
      return "A\thttps://a.example.com/x?token=1#f\n"
    }
    const [s] = await browserTabsSource(run).readAsync!({})
    expect(s.value).toBe("Google Chrome: A (https://a.example.com/x)")
    expect(s.reason).toMatch(/Safari: not allowed/)
    expect(bareAddress("javascript:alert(1)")).toBe("javascript:…")
    expect(bareAddress("not a url")).toBe("")
  })

  it("news: RSS and Atom headlines; a feed down is a reason, not an error", async () => {
    expect(feedHeadlines(`<feed><entry><title type="html"><![CDATA[Hello <b>world</b>]]></title><link href="https://n.example.com/1"/></entry></feed>`, 5))
      .toEqual(["Hello world (https://n.example.com/1)"])
    const src = newsSource(() => ({ feeds: ["https://n.example.com/f", "https://down.example.com/f"], maxItems: 3, timeoutMs: 100 }),
      async (u) => { if (u.includes("down")) throw new Error("HTTP 500"); return "<rss><item><title>One</title></item></rss>" })
    const [s] = await src.readAsync!({})
    expect(s.value).toBe("One")
    expect(s.reason).toMatch(/down: https:\/\/down\.example\.com\/f: HTTP 500/)
    const none = newsSource(() => ({ feeds: [], maxItems: 3, timeoutMs: 100 }))
    expect((await none.readAsync!({}))[0].reason).toMatch(/situations\.news\.feeds/)
  })
})
