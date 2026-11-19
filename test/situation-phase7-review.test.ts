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
import { clearPopupYes, popupYesFor, recordPopupYes } from "../src/situations/sources/popup-yes"
import { sourcesAsk, sourcesRead, sourcesTurnFrom, type SourcesTurn } from "../src/situations/sources/request-api"
import { browserTabsSource, fetchFeed, isPrivateAddress, openAppsSource, type RunCommand } from "../src/situations/sources/per-request"
import { readCard, saveCard, type DecisionCard } from "../src/approvals/cards"
import { popNext, type PopupRunnerSettings } from "../src/approvals/popup-runner"
import { chatSecret, taskSecret, TURN_SECRET_ENV } from "../src/agents/turn-secret"
import { SOURCES_READ_MARK } from "../src/situations/sources/redact"

// #1892 phase 7, second independent review. Each fix has its test here,
// written before the fix. Neutral ids only.

const AGENT = "helper"
const OTHER = "writer"
const TASK = "task-0001"
const CONSENT = { askMinutes: 60, defaultMinutes: 15, maxMinutes: 60, maxReads: 3, reaskMinutes: 0 }

let root: string
let db: Database.Database
let log: SourceReadLog
let attached: AttachedSources | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agentx-1892p7r-"))
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

/** The fake Mac: lsappinfo for apps, osascript for tabs. */
function fakeMac() {
  return vi.fn<RunCommand>(async (cmd, args) => {
    if (cmd === "lsappinfo" && args[0] === "front") return "ASN:0x0-0x1:\n"
    if (cmd === "lsappinfo" && args[0] === "info") return "\"LSDisplayName\"=\"Notes\"\n"
    if (cmd === "lsappinfo" && args[0] === "visibleProcessList") return "ASN:0x0-0x1-\"Notes\": ASN:0x0-0x2-\"Activity_Monitor\": ASN:0x0-0x3-\"‎Mail\":\n"
    if (cmd === "osascript" && args.join(" ").includes("Google Chrome")) return "Docs home\thttps://docs.example.com/start/person@example.com?session=abc#top\n"
    return ""
  })
}

function settingsWith(sources: SituationsConfig["sources"], over: Record<string, unknown> = {}): SituationsConfig {
  return situationsConfigSchema.parse({ ...DEFAULT_SITUATIONS_CONFIG, consent: CONSENT, ...over, sources })
}

function attach(settings: () => SituationsConfig, run: RunCommand, tabs?: RunCommand): AttachedSources {
  attached = attachSignalSources({
    store: new SituationStore(db),
    settings,
    calls: () => undefined,
    consent: cardConsent(root, { maxReads: () => settings().consent.maxReads, readsSoFar: (id) => log.list({ requestId: id, limit: 500 }).length }),
    readLog: log,
    runCommand: run,
    ...(tabs ? { browserTabsReader: tabs } : {}),
    platform: "darwin",
  })
  return attached
}

const TURN: SourcesTurn = { agentId: AGENT, taskId: TASK, chat: "telegram:100", reply: { channel: "telegram", chatId: "100" } }

function ask(a: AttachedSources, body: Record<string, unknown>, over: Partial<Parameters<typeof sourcesAsk>[1]> = {}, settings = CONSENT) {
  return sourcesAsk(body, { local: true, turn: TURN, sources: a.sources, root, settings, popupOn: true, ...over })
}

function read(a: AttachedSources, body: Record<string, unknown>, over: Partial<Parameters<typeof sourcesRead>[1]> = {}) {
  return sourcesRead(body, { local: true, turn: TURN, sources: a.sources, root, ...over })
}

/** The person clicks Yes in the popup: the daemon's popup runner. */
async function clickYes(id: string, now = Date.now()) {
  const POPUP: PopupRunnerSettings = { enabled: true, speak: false, sound: "", volume: 0, timeoutSeconds: 60 }
  const shown: string[] = []
  const r = await popNext({
    ctx: { root, now }, settings: POPUP, log: () => {}, platform: "darwin",
    focus: () => ({ active: false, mode: null, reason: "test" }),
    show: async (card) => { shown.push(card.id); return { action: "yes" as const } },
  })
  expect(r).toBe("shown")
  expect(shown).toEqual([id])
}

describe("1a: the card file alone never grants", () => {
  it("a fully forged card (decided, yes, from the popup, a day long) is refused and nothing is read", async () => {
    const run = fakeMac()
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), run)
    const id = String(ask(a, { sources: ["open-apps"], why: "front app" }).body.request)
    const card = readCard(root, id)!
    saveCard(root, {
      ...card, status: "decided", verdict: "yes", decided_from: "popup", decided_at: new Date().toISOString(),
      origin: { kind: "source-consent", agentId: AGENT, sources: ["open-apps", "browser-tabs"], minutes: 1440, taskId: TASK },
    })
    const r = await read(a, { source: "open-apps", request: id })
    expect(r.body.consent).toBe("no yes was clicked in the popup for this request since the daemon started")
    expect(run).not.toHaveBeenCalled()
    expect(log.list()).toEqual([])
  })

  it("a yes clicked in the daemon's popup is kept in memory, with what the card showed", async () => {
    const run = fakeMac()
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), run)
    const id = String(ask(a, { sources: ["open-apps"], why: "front app", minutes: 15 }).body.request)
    await clickYes(id)
    expect(popupYesFor(id)).toMatchObject({ cardId: id, agentId: AGENT, sources: ["open-apps"], minutes: 15, taskId: TASK })
    // The agent rewrites its card afterwards: the shown minutes and sources hold.
    const card = readCard(root, id)!
    saveCard(root, { ...card, origin: { kind: "source-consent", agentId: AGENT, sources: ["open-apps", "browser-tabs"], minutes: 1440, taskId: TASK } })
    expect(consentState(readCard(root, id), "browser-tabs", AGENT, Date.now(), { taskId: TASK }).granted).toBe(false)
    expect(consentState(readCard(root, id), "open-apps", AGENT, Date.now() + 20 * 60_000, { taskId: TASK }).granted).toBe(false)
    const r = await read(a, { source: "open-apps", request: id })
    expect((r.body.answers as Array<{ kind: string; value: unknown }>).find((s) => s.kind === "front-app")?.value).toBe("Notes")
    expect(log.list()).toHaveLength(1)
  })

  it("a restart ends every yes (memory is empty)", async () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const id = String(ask(a, { sources: ["open-apps"], why: "front app" }).body.request)
    await clickYes(id)
    clearPopupYes()
    expect((await read(a, { source: "open-apps", request: id })).body.consent).toMatch(/no yes was clicked/)
  })

  it("only the popup runner records a yes: a no records nothing", async () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const id = String(ask(a, { sources: ["open-apps"], why: "front app" }).body.request)
    const card = readCard(root, id)! as DecisionCard
    recordPopupYes({ ...card, origin: { kind: "number", numberId: "x", streakStart: 0 } } as DecisionCard, Date.now())
    expect(popupYesFor(id)).toBeNull()
  })
})

describe("1b: apps without extra permissions; tabs not read without a separate reader", () => {
  it("open apps comes from lsappinfo (no Automation or Accessibility), no window title", async () => {
    const out = await openAppsSource(fakeMac()).readAsync!({})
    expect(out.map((s) => [s.kind, s.value])).toEqual([["front-app", "Notes"], ["open-apps", "Notes, Activity Monitor, Mail"]])
  })

  it("the daemon does not load browser-tabs without a separate reader, and says why", () => {
    const a = attach(() => settingsWith({ "browser-tabs": { enabled: true } }), fakeMac())
    expect(a.sources.loaded().map((s) => s.id)).not.toContain("browser-tabs")
    expect(a.sources.skipped().find((s) => s.id === "browser-tabs")?.reason).toMatch(/separate reader/)
    expect(ask(a, { sources: ["browser-tabs"], why: "tabs" }).status).toBe(409)
  })
})

describe("2: the turn is proven by a per-turn secret, not the public task id", () => {
  const deps = {
    taskOwner: (id: string) => (id === TASK ? AGENT : id === "task-b" ? OTHER : null),
    findRunningTurn: (agentId: string, by: { taskId?: string; channel?: string; chatId?: string }) =>
      (agentId === AGENT && by.taskId === TASK) ? { taskId: TASK, context: { channel: "telegram", chatId: "100" } }
        : (agentId === OTHER && by.taskId === "task-b") ? { taskId: "task-b", context: { channel: "telegram", chatId: "200" } }
        : (agentId === AGENT && by.channel === "telegram" && by.chatId === "100") ? { taskId: TASK, context: { channel: "telegram", chatId: "100" } }
        : null,
  }
  it("a task id without its secret, or with another turn's secret, is refused", () => {
    expect(sourcesTurnFrom({ taskId: TASK }, undefined, deps)).toBeNull()
    expect(sourcesTurnFrom({ taskId: "task-b", secret: taskSecret(TASK) }, undefined, deps)).toBeNull()
    expect(sourcesTurnFrom({ taskId: "task-b", secret: "0".repeat(40) }, undefined, deps)).toBeNull()
    expect(sourcesTurnFrom({ taskId: TASK, secret: taskSecret(TASK) }, undefined, deps)?.agentId).toBe(AGENT)
    expect(sourcesTurnFrom({ channel: "telegram", chatId: "100" }, AGENT, deps)).toBeNull()
    expect(sourcesTurnFrom({ channel: "telegram", chatId: "100", secret: chatSecret(OTHER, "telegram", "100") }, AGENT, deps)).toBeNull()
    expect(sourcesTurnFrom({ channel: "telegram", chatId: "100", secret: chatSecret(AGENT, "telegram", "100") }, AGENT, deps)?.agentId).toBe(AGENT)
  })

  it("the tool sends the secret from its environment", async () => {
    const { runSourcesTool } = await import("../src/situations/sources-tool")
    const fetch = vi.fn(async (_u: string, _i: RequestInit) => new Response(JSON.stringify({ answers: [] }), { status: 200 }))
    await runSourcesTool({ action: "read", source: "news" }, { daemonUrl: "http://127.0.0.1:1", fetch, env: { AGENTX_TASK_ID: TASK, [TURN_SECRET_ENV]: "s3cret" } })
    expect((fetch.mock.calls[0][1].headers as Record<string, string>)["X-AgentX-Turn-Secret"]).toBe("s3cret")
  })
})

describe("3: only the asking task and the answer turn; reads per yes are capped", () => {
  it("another turn in the same chat cannot use the yes", async () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const id = String(ask(a, { sources: ["open-apps"], why: "front app" }).body.request)
    await clickYes(id)
    const r = await read(a, { source: "open-apps", request: id }, { turn: { ...TURN, taskId: "task-later" } })
    expect(r.body.consent).toBe("asked from another turn")
    expect(log.list()).toEqual([])
  })

  it("at most maxReads reads per yes", async () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const id = String(ask(a, { sources: ["open-apps"], why: "front app" }).body.request)
    await clickYes(id)
    for (let i = 0; i < 3; i++) await read(a, { source: "open-apps", request: id })
    const r = await read(a, { source: "open-apps", request: id })
    expect(r.body.consent).toBe("the yes was used for 3 reads already")
    expect(log.list()).toHaveLength(3)
  })

  it("the card names the chat and says the answer may be posted there", () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const card = readCard(root, String(ask(a, { sources: ["open-apps"], why: "front app" }).body.request))!
    expect(card.ask).toContain("Asked in telegram chat 100; the answer may be posted there.")
  })
})

describe("4: read content does not reach the turn-progress seat", () => {
  it("turn-seats keeps the redacted text for an agentx_sources result", async () => {
    const { redactedToolResult } = await import("../src/agents/turn-seats")
    expect(redactedToolResult(`${SOURCES_READ_MARK}\nfront-app: Notes`)).not.toContain("Notes")
  })
})

describe("5: tab addresses are the site only, unless the owner asks for paths", () => {
  it("origin only by default", async () => {
    const run = fakeMac()
    const [s] = await browserTabsSource(run).readAsync!({})
    expect(s.value).toBe("Google Chrome: Docs home (https://docs.example.com)")
    const [p] = await browserTabsSource(run, () => true).readAsync!({})
    expect(p.value).toBe("Google Chrome: Docs home (https://docs.example.com/start/person@example.com)")
  })
})

describe("6: news feeds stay public and small", () => {
  it("private, loopback and link-local addresses are refused, also after a redirect", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "0.0.0.0", "100.64.0.1"]) expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) expect(isPrivateAddress(ip)).toBe(false)
    const lookup = async (host: string) => (host === "inside.example.com" ? ["10.0.0.5"] : ["93.184.216.34"])
    const redirectTo = (loc: string) => vi.fn(async () => new Response(null, { status: 302, headers: { location: loc } }))
    await expect(fetchFeed("https://news.example.com/f", 1000, { fetch: redirectTo("http://169.254.169.254/latest"), lookup })).rejects.toThrow(/private/)
    await expect(fetchFeed("https://news.example.com/f", 1000, { fetch: redirectTo("https://inside.example.com/x"), lookup })).rejects.toThrow(/private/)
    await expect(fetchFeed("https://inside.example.com/f", 1000, { fetch: vi.fn(), lookup })).rejects.toThrow(/private/)
  })

  it("a feed body is cut at the size cap", async () => {
    const lookup = async () => ["93.184.216.34"]
    const big = "<rss>" + "x".repeat(3_000_000) + "</rss>"
    const text = await fetchFeed("https://news.example.com/f", 1000, { fetch: vi.fn(async () => new Response(big, { status: 200 })), lookup, maxBytes: 1000 })
    expect(text.length).toBeLessThanOrEqual(1000)
  })
})

describe("7: no click fatigue", () => {
  it("one pending ask per agent; a no or no answer blocks asks for reaskMinutes", async () => {
    const a = attach(() => settingsWith({ "open-apps": { enabled: true } }), fakeMac())
    const s = { ...CONSENT, reaskMinutes: 30 }
    const first = ask(a, { sources: ["open-apps"], why: "front app" }, {}, s)
    expect(first.status).toBe(201)
    const second = ask(a, { sources: ["open-apps"], why: "again" }, {}, s)
    expect(second.status).toBe(409)
    expect(String(second.body.error)).toMatch(/still waiting/)
    const card = readCard(root, String(first.body.request))!
    saveCard(root, { ...card, status: "decided", verdict: "no", decided_at: new Date().toISOString() })
    const third = ask(a, { sources: ["open-apps"], why: "again" }, {}, s)
    expect(third.status).toBe(409)
    expect(String(third.body.error)).toMatch(/30 minutes/)
    // Another agent is not blocked.
    expect(ask(a, { sources: ["open-apps"], why: "x" }, { turn: { ...TURN, agentId: OTHER, taskId: "task-b" } }, s).status).toBe(201)
  })
})
