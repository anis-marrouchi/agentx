import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

const mocks = vi.hoisted(() => ({ execSync: vi.fn() }))
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), execSync: mocks.execSync }))

import { WikiHub } from "../../src/wiki/hub"
import { wiki } from "../../src/commands/wiki"

const AGENT = "coder"

let dir: string
let hub: WikiHub

function addEntries(ids: Array<[string, string]>): void {
  for (const [id, date] of ids) {
    hub.getSharedStore().addEntry({ id, date, agentId: AGENT, source: "telegram", content: `entry ${id}` })
  }
}

function ledgerFile(): string {
  return resolve(dir, "agents", AGENT, "_absorbed.json")
}

async function absorb(...args: string[]): Promise<void> {
  await wiki.parseAsync(["absorb", "--dir", dir, "--agent", AGENT, "--no-facts", ...args], { from: "user" })
}

function envelope(result: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ result: JSON.stringify(result), ...extra })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "absorb-ledger-"))
  hub = new WikiHub(dir, () => {})
  mocks.execSync.mockReset()
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("WikiHub absorb ledger", () => {
  it("drops an uncited entry from the queue once it is marked processed", () => {
    addEntries([["e1", "2026-09-08"], ["e2", "2026-09-08"], ["e3", "2026-09-09"]])

    hub.markProcessed(AGENT, ["e1", "e2"], ["e1"])

    expect(hub.getUnabsorbedEntries(AGENT).map((e) => e.id)).toEqual(["e3"])
    const ledger = JSON.parse(readFileSync(ledgerFile(), "utf-8"))
    expect(ledger.entries.e1.cited).toBe(true)
    expect(ledger.entries.e2.cited).toBe(false)
  })

  it("reports cited and read-not-cited separately", () => {
    addEntries([["e1", "2026-09-08"], ["e2", "2026-09-08"], ["e3", "2026-09-09"]])
    hub.getAgentWiki(AGENT).writeArticle("concept/one.md", {
      title: "One", tags: [], owner: AGENT, access: "public",
      created: "2026-09-08", lastUpdated: "2026-09-08", sources: ["e1"],
    }, "body", AGENT)
    hub.markProcessed(AGENT, ["e1", "e2"], ["e1"])

    const s = hub.summary().find((a) => a.agentId === AGENT)!
    expect(s).toMatchObject({ totalEntries: 3, cited: 1, readNotCited: 1, unabsorbed: 1 })
  })

  it("refuses a damaged ledger instead of treating it as empty", () => {
    addEntries([["e1", "2026-09-08"]])
    mkdirSync(resolve(dir, "agents", AGENT), { recursive: true })
    writeFileSync(ledgerFile(), "{not json")

    expect(() => hub.getUnabsorbedEntries(AGENT)).toThrow(/absorb ledger/)
  })
})

describe("wiki absorb", () => {
  it("does not offer an uncited entry again on the next run", async () => {
    addEntries([["e1", "2026-09-08"], ["e2", "2026-09-08"], ["e3", "2026-09-09"]])
    mocks.execSync.mockReturnValueOnce(envelope({
      articles: [{ path: "concept/one.md", title: "One", tags: [], content: "body", sources: ["e1"] }],
      gaps: [],
    }))

    await absorb("--max", "2")

    const prompt = readFileSync(resolve(dir, "agents", AGENT, "graph", "_tmp", "absorb-prompt.txt"), "utf-8")
    expect(prompt).toContain("ENTRY e2")
    expect(hub.getUnabsorbedEntries(AGENT).map((e) => e.id)).toEqual(["e3"])
  })

  it("leaves the ledger untouched when the output cannot be parsed", async () => {
    addEntries([["e1", "2026-09-08"]])
    mocks.execSync.mockReturnValueOnce(JSON.stringify({ result: "I could not do that." }))

    await absorb()

    expect(existsSync(ledgerFile())).toBe(false)
    expect(hub.getUnabsorbedEntries(AGENT).map((e) => e.id)).toEqual(["e1"])
  })

  it("leaves the ledger untouched when claude exits with an error", async () => {
    addEntries([["e1", "2026-09-08"]])
    mocks.execSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("exit 1"), { stdout: envelope({ articles: [], gaps: [] }) })
    })

    await absorb()

    expect(existsSync(ledgerFile())).toBe(false)
  })

  it("leaves the ledger untouched when the envelope reports an error", async () => {
    addEntries([["e1", "2026-09-08"]])
    mocks.execSync.mockReturnValueOnce(envelope({ articles: [], gaps: [] }, { is_error: true }))

    await absorb()

    expect(existsSync(ledgerFile())).toBe(false)
  })

  it("keeps a prior ledger intact when a later run fails", async () => {
    addEntries([["e1", "2026-09-08"], ["e2", "2026-09-09"]])
    hub.markProcessed(AGENT, ["e1"], [])
    const before = readFileSync(ledgerFile(), "utf-8")
    mocks.execSync.mockImplementationOnce(() => { throw new Error("timed out") })

    await absorb()

    expect(readFileSync(ledgerFile(), "utf-8")).toBe(before)
  })

  it("--until bounds the window from above", async () => {
    addEntries([["e1", "2026-09-08"], ["e2", "2026-09-09"], ["e3", "2026-09-10"]])

    await absorb("--dry-run", "--since", "2026-09-09", "--until", "2026-09-09")

    const out = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n")
    expect(out).toContain("1 entries to absorb")
    expect(mocks.execSync).not.toHaveBeenCalled()
  })
})
