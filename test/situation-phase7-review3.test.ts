import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SituationStore } from "../src/situations/store"
import { DEFAULT_SITUATIONS_CONFIG, situationsConfigSchema, type SituationsConfig } from "../src/situations/config"
import { attachSignalSources, type AttachedSources } from "../src/situations/sources/node"
import { SourceReadLog } from "../src/situations/sources/read-log"
import { cardConsent, consentState } from "../src/situations/sources/consent"
import { clearPopupYes, popupYesFor, recordAnswerTurn } from "../src/situations/sources/popup-yes"
import { sourcesAsk, sourcesRead, type SourcesTurn } from "../src/situations/sources/request-api"
import { fetchFeed, isPrivateAddress, type RunCommand } from "../src/situations/sources/per-request"
import { readCard, saveCard, type DecisionCard } from "../src/approvals/cards"
import { popNext, type PopupRunnerSettings } from "../src/approvals/popup-runner"
import { sourcesToolOn } from "../src/situations/context"

// #1892 phase 7, third review: the card an agent can rewrite while it
// waits, the answer turn, DNS pinning for feeds, and the tool listing.
// Neutral ids only.

const AGENT = "helper"
const TASK = "task-0001"
const CONSENT = { askMinutes: 60, defaultMinutes: 15, maxMinutes: 60, maxReads: 3, reaskMinutes: 0 }
const POPUP: PopupRunnerSettings = { enabled: true, speak: false, sound: "", volume: 0, timeoutSeconds: 60 }

let root: string
let db: Database.Database
let log: SourceReadLog
let attached: AttachedSources | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentx-1892p7r3-"))
  db = new Database(":memory:")
  log = new SourceReadLog(db)
  clearPopupYes()
})

afterEach(() => {
  attached?.detach()
  attached = null
  db.close()
  rmSync(root, { recursive: true, force: true })
  clearPopupYes()
})

function fakeMac() {
  return vi.fn<RunCommand>(async (cmd, args) => {
    if (cmd === "lsappinfo" && args[0] === "front") return "ASN:0x0-0x1:\n"
    if (cmd === "lsappinfo" && args[0] === "info") return "\"LSDisplayName\"=\"Notes\"\n"
    if (cmd === "lsappinfo" && args[0] === "visibleProcessList") return "ASN:0x0-0x1-\"Notes\":\n"
    return ""
  })
}

function attach(run: RunCommand): AttachedSources {
  const settings = (): SituationsConfig => situationsConfigSchema.parse({
    ...DEFAULT_SITUATIONS_CONFIG, consent: CONSENT,
    sources: { "open-apps": { enabled: true }, news: { enabled: true, consent: "person" } },
    news: { feeds: ["https://news.example.com/feed.xml"] },
  })
  attached = attachSignalSources({
    store: new SituationStore(db), settings, calls: () => undefined,
    consent: cardConsent(root, { maxReads: () => CONSENT.maxReads, maxMinutes: () => CONSENT.maxMinutes, readsSoFar: (id) => log.list({ requestId: id, limit: 500 }).length }),
    readLog: log, runCommand: run, fetchText: async () => "<rss><item><title>Rain</title></item></rss>", platform: "darwin",
  })
  return attached
}

const TURN: SourcesTurn = { agentId: AGENT, taskId: TASK, chat: "telegram:100", reply: { channel: "telegram", chatId: "100" } }

async function pop(show: (card: DecisionCard) => Promise<{ action: "yes" | "no" | "dismiss" }>, now = Date.now()) {
  return popNext({
    ctx: { root, now }, settings: POPUP, log: () => {}, platform: "darwin",
    focus: () => ({ active: false, mode: null, reason: "test" }),
    show: async (card) => show(card) as any,
    returnToAuthor: () => {},
  })
}

describe("MUST 1: the popup shows, and the yes grants, only what the daemon asked", () => {
  it("the reviewer's exploit: a waiting card rewritten to other sources and a day is refused", async () => {
    const run = fakeMac()
    const a = attach(run)
    const id = String(sourcesAsk({ sources: ["news"], why: "headlines", minutes: 15 }, { local: true, turn: TURN, sources: a.sources, root, settings: CONSENT, popupOn: true }).body.request)
    const card = readCard(root, id)!
    saveCard(root, {
      ...card,
      title: "helper asks to read the news",
      origin: { kind: "source-consent", agentId: AGENT, sources: ["browser-tabs", "open-apps"], minutes: 1440, taskId: TASK },
    })
    const shown: DecisionCard[] = []
    await pop(async (c) => { shown.push(c); return { action: "yes" } })
    // Never shown with the agent's edit; no yes kept.
    for (const c of shown) expect(c.origin).toMatchObject({ sources: ["news"], minutes: 15 })
    expect(popupYesFor(id)).toBeNull()
    const r = await sourcesRead({ source: "open-apps", request: id }, { local: true, turn: TURN, sources: a.sources, root })
    expect(r.body.consent).toBeDefined()
    expect(run).not.toHaveBeenCalled()
    expect(log.list()).toEqual([])
  })

  it("the popup shows the text the daemon wrote, not the file's", async () => {
    const a = attach(fakeMac())
    const id = String(sourcesAsk({ sources: ["open-apps"], why: "front app" }, { local: true, turn: TURN, sources: a.sources, root, settings: CONSENT, popupOn: true }).body.request)
    const asked = readCard(root, id)!
    saveCard(root, { ...asked, ask: "Let helper fix your printer?" })
    const shown: DecisionCard[] = []
    await pop(async (c) => { shown.push(c); return { action: "dismiss" } })
    for (const c of shown) expect(c.ask).toBe(asked.ask)
  })

  it("an edit while the popup is up voids the yes", async () => {
    const a = attach(fakeMac())
    const id = String(sourcesAsk({ sources: ["open-apps"], why: "front app" }, { local: true, turn: TURN, sources: a.sources, root, settings: CONSENT, popupOn: true }).body.request)
    await pop(async (c) => {
      saveCard(root, { ...readCard(root, c.id)!, origin: { kind: "source-consent", agentId: AGENT, sources: ["open-apps"], minutes: 60, taskId: TASK } })
      return { action: "yes" }
    })
    expect(popupYesFor(id)).toBeNull()
  })

  it("a card the daemon did not ask (after a restart, or written by hand) never gets a yes", async () => {
    const a = attach(fakeMac())
    const id = String(sourcesAsk({ sources: ["open-apps"], why: "front app" }, { local: true, turn: TURN, sources: a.sources, root, settings: CONSENT, popupOn: true }).body.request)
    clearPopupYes() // the daemon restarted: it no longer knows the ask
    const shown: string[] = []
    await pop(async (c) => { shown.push(c.id); return { action: "yes" } })
    expect(shown).toEqual([])
    expect(popupYesFor(id)).toBeNull()
  })

  it("the yes never lasts longer than maxMinutes now says", () => {
    const at = Date.parse("2030-01-01T10:00:00Z")
    const base = {
      id: "2030-01-01-c-aaaa", title: "t", ask: "a", recommend: "r", if_silent: "discard" as const, expires: "2030-01-02T00:00:00Z",
      raised_by: AGENT, created_at: "2030-01-01T09:00:00Z", popup_only: true as const, status: "decided" as const, verdict: "yes" as const,
      decided_from: "popup" as const, decided_at: "2030-01-01T10:00:00Z",
      origin: { kind: "source-consent" as const, agentId: AGENT, sources: ["open-apps"], minutes: 600, taskId: TASK },
    }
    const yes = { cardId: base.id, clickedAt: at, agentId: AGENT, sources: ["open-apps"], minutes: 600, taskId: TASK, expires: Date.parse(base.expires) }
    expect(consentState(base, "open-apps", AGENT, at + 61 * 60_000, { taskId: TASK }, { yes, maxMinutes: 60 }).granted).toBe(false)
    expect(consentState(base, "open-apps", AGENT, at + 59 * 60_000, { taskId: TASK }, { yes, maxMinutes: 60 }).granted).toBe(true)
  })
})

describe("small: the answer turn is the one the daemon started", () => {
  it("only the recorded answer task may read from approvals:<card>", () => {
    const at = Date.parse("2030-01-01T10:00:00Z")
    const base = {
      id: "2030-01-01-c-bbbb", title: "t", ask: "a", recommend: "r", if_silent: "discard" as const, expires: "2030-01-02T00:00:00Z",
      raised_by: AGENT, created_at: "2030-01-01T09:00:00Z", popup_only: true as const, status: "decided" as const, verdict: "yes" as const,
      decided_from: "popup" as const, decided_at: "2030-01-01T10:00:00Z",
      origin: { kind: "source-consent" as const, agentId: AGENT, sources: ["open-apps"], minutes: 15, taskId: TASK },
    }
    const yes = { cardId: base.id, clickedAt: at, agentId: AGENT, sources: ["open-apps"], minutes: 15, taskId: TASK, expires: Date.parse(base.expires) }
    const answer = { chat: `approvals:${base.id}`, taskId: "task-answer" }
    expect(consentState(base, "open-apps", AGENT, at + 60_000, answer, { yes }).granted).toBe(false) // nothing recorded
    recordAnswerTurn(base.id, "task-answer")
    expect(consentState(base, "open-apps", AGENT, at + 60_000, answer, { yes }).granted).toBe(true)
    expect(consentState(base, "open-apps", AGENT, at + 60_000, { ...answer, taskId: "task-extra" }, { yes }).granted).toBe(false)
  })
})

describe("small: feeds", () => {
  it("benchmark and NAT64 ranges are private too", () => {
    for (const ip of ["198.18.0.1", "198.19.255.254", "64:ff9b::a00:1"]) expect(isPrivateAddress(ip)).toBe(true)
    expect(isPrivateAddress("198.20.0.1")).toBe(false)
  })

  it("IPv4-compatible, 6to4 and 192.0.0.0/24 addresses are private too (#1987)", () => {
    for (const ip of ["::127.0.0.1", "::10.0.0.1", "::7f00:1", "0:0:0:0:0:0:a00:1", "::8.8.8.8", "2002:7f00:1::", "2002:a00:1::1", "2002:c0a8:101::", "::ffff:127.0.0.1", "::ffff:7f00:1", "0064:ff9b::7f00:1", "192.0.0.1", "192.0.0.170"]) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ["2002:5db8:d822::1", "::ffff:93.184.216.34", "64:ff9b::5db8:d822", "192.0.1.1", "192.1.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      expect(isPrivateAddress(ip), ip).toBe(false)
    }
  })

  it("the connection goes to the address that was checked (no second DNS answer)", async () => {
    const lookup = vi.fn(async () => ["93.184.216.34"])
    const fetch = vi.fn(async (_u: string, init: RequestInit & { dispatcher?: unknown }) => {
      expect(init.dispatcher).toBeDefined()
      return new Response("<rss></rss>", { status: 200 })
    })
    await fetchFeed("https://news.example.com/f", 1000, { fetch, lookup })
    expect(lookup).toHaveBeenCalledTimes(1)
  })
})

describe("small: the tool is not listed for a source that never loads", () => {
  it("browser-tabs alone does not list agentx_sources", () => {
    expect(sourcesToolOn({ "browser-tabs": { enabled: true } })).toBe(false)
    expect(sourcesToolOn({ "open-apps": { enabled: true } })).toBe(true)
  })
})
