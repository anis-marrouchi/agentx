import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

// #808: absorb telemetry and the absorb-eval / absorb-runs commands.

const mocks = vi.hoisted(() => ({ execSync: vi.fn() }))
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), execSync: mocks.execSync }))

import { WikiHub } from "../../src/wiki/hub"
import { wiki } from "../../src/commands/wiki"

let dir: string
let hub: WikiHub

function envelope(result: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ result: JSON.stringify(result), ...extra })
}

function addEntry(agentId: string, id: string, content = `entry ${id}`): void {
  hub.getSharedStore().addEntry({ id, date: "2026-10-07", agentId, source: "telegram", content })
}

function telemetry(): any[] {
  const file = resolve(dir, "_absorb-runs.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "absorb-runs-"))
  hub = new WikiHub(dir, () => {})
  mocks.execSync.mockReset()
  // Commander keeps option values between parses of the same command.
  for (const c of wiki.commands) for (const o of c.options) c.setOptionValue(o.attributeName(), o.defaultValue)
  vi.spyOn(console, "log").mockImplementation(() => {})
  process.exitCode = undefined
})

afterEach(() => {
  process.exitCode = undefined
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe("absorb telemetry", () => {
  it("records each compile call and the run, with cost from the envelope", async () => {
    addEntry("coder", "e1")
    mocks.execSync.mockReturnValueOnce(envelope(
      { articles: [{ path: "concepts/one.md", title: "One", tags: [], content: "body", sources: ["e1"] }], gaps: [] },
      { total_cost_usd: 0.05, duration_api_ms: 21000, usage: { input_tokens: 12, output_tokens: 800 } },
    ))

    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts", "--run-label", "baseline"], { from: "user" })

    const [call, run] = telemetry()
    expect(call).toMatchObject({
      kind: "call", label: "baseline", agent: "coder", entries: 1, articles: 1, refused: 0,
      failed: false, costUsd: 0.05, apiMs: 21000, outputTokens: 800,
    })
    expect(call.promptChars).toBeGreaterThan(0)
    expect(call.promptParts.entries).toBeGreaterThan(0)
    expect(call.promptParts.catalogArticles).toBe(0)
    expect(run).toMatchObject({ kind: "run", label: "baseline", max: 10 })
  })

  it("counts held entries another saved article cites", async () => {
    addEntry("coder", "e1")
    hub.getAgentWiki("coder").writeArticle("concepts/one.md", {
      title: "One", tags: [], owner: "coder", access: "public",
      created: "2026-10-06", lastUpdated: "2026-10-06", sources: ["e0"],
    }, "Released in commit 1a01e02.", "coder")
    mocks.execSync.mockReturnValueOnce(envelope({
      articles: [
        // Drops the commit: refused, e1 held.
        { path: "concepts/one.md", title: "One", tags: [], content: "Released.", sources: ["e1"] },
        // Saved, and cites e1 too.
        { path: "concepts/two.md", title: "Two", tags: [], content: "Second.", sources: ["e1"] },
      ],
      gaps: [],
    }))

    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts"], { from: "user" })

    expect(telemetry()[0]).toMatchObject({ articles: 1, refused: 1, heldCited: 1 })
    // Today the refused update is not offered again; heldCited counts
    // those. A fix that keeps held entries queued changes this line.
    expect(hub.getUnabsorbedEntries("coder")).toEqual([])
  })

  it("records a failed call as failed", async () => {
    addEntry("coder", "e1")
    mocks.execSync.mockReturnValueOnce(JSON.stringify({ result: "no json here" }))

    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts"], { from: "user" })

    expect(telemetry()[0]).toMatchObject({ kind: "call", failed: true, articles: 0 })
  })

  // #603: a schedule running absorb as a command sees the failure.
  it("exits 1 and counts the failure on the run line when a call fails", async () => {
    addEntry("coder", "e1")
    mocks.execSync.mockImplementationOnce(() => { throw Object.assign(new Error("claude not found"), { stdout: "" }) })

    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts"], { from: "user" })

    expect(process.exitCode).toBe(1)
    expect(telemetry()[1]).toMatchObject({ kind: "run", failed: 1 })
    expect(hub.getUnabsorbedEntries("coder").map((e) => e.id)).toEqual(["e1"])
  })

  it("exits 1 when the model reports an error", async () => {
    addEntry("coder", "e1")
    mocks.execSync.mockReturnValueOnce(envelope({ articles: [], gaps: [] }, { is_error: true }))

    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts"], { from: "user" })

    expect(process.exitCode).toBe(1)
  })

  it("exits 0 when every call succeeds", async () => {
    addEntry("coder", "e1")
    mocks.execSync.mockReturnValueOnce(envelope({ articles: [], gaps: [] }))

    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts"], { from: "user" })

    expect(process.exitCode).toBeUndefined()
    expect(telemetry()[1]).toMatchObject({ kind: "run", failed: 0 })
  })

  it("writes nothing on a dry run", async () => {
    addEntry("coder", "e1")
    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts", "--dry-run"], { from: "user" })
    expect(telemetry()).toEqual([])
  })

  it("absorb-runs summarises by label", async () => {
    addEntry("coder", "e1")
    mocks.execSync.mockReturnValueOnce(envelope({ articles: [], gaps: [] }, { total_cost_usd: 0.1 }))
    await wiki.parseAsync(["absorb", "--dir", dir, "--agent", "coder", "--no-facts", "--run-label", "x"], { from: "user" })

    vi.mocked(console.log).mockClear()
    await wiki.parseAsync(["absorb-runs", "--dir", dir, "--json"], { from: "user" })
    const summary = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))
    expect(summary).toEqual([expect.objectContaining({ label: "x", calls: 1, entries: 1, costUsd: 0.1 })])
  })
})

describe("absorb-eval", () => {
  it("scores the articles changed in the window, and the uncited entries", async () => {
    addEntry("coder", "e1", "Merged the voice login fix in commit 1a01e02; review https://code.example.test/reviews/311.")
    addEntry("coder", "e2", "Billing hotfix shipped in commit 9f3c2d1.")
    hub.getAgentWiki("coder").writeArticle("events/voice-login-fix.md", {
      title: "Voice login fix", type: "event", tags: [], owner: "coder", access: "public",
      created: "2026-10-07", lastUpdated: "2026-10-07", sources: ["e1"],
    }, "The voice login fix merged in commit 1a01e02 and 7bb9e10.", "coder")
    hub.markProcessed("coder", ["e1", "e2"], ["e1"])

    await wiki.parseAsync(["absorb-eval", "--dir", dir, "--json"], { from: "user" })

    const { card, checks } = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))
    expect(card.sample.articles).toBe(1)
    expect(checks[0].ungrounded).toEqual(["commit 7bb9e10"])
    expect(checks[0].lost).toEqual([{ entry: "e1", fact: "link https://code.example.test/reviews/311" }])
    expect(card.uncited).toEqual({ entries: 1, withLostFacts: 1 })
  })

  it("saves the sample and reads it back", async () => {
    addEntry("coder", "e1")
    for (const n of [1, 2, 3]) {
      hub.getAgentWiki("coder").writeArticle(`concepts/c${n}.md`, {
        title: `Concept ${n}`, type: "concept", tags: [], owner: "coder", access: "public",
        created: "2026-10-07", lastUpdated: "2026-10-07", sources: ["e1"],
      }, `entry e1 concept ${n}`, "coder")
    }
    const sample = join(dir, "sample.json")
    await wiki.parseAsync(["absorb-eval", "--dir", dir, "--n", "2", "--sample", sample, "--json"], { from: "user" })
    const saved = JSON.parse(readFileSync(sample, "utf-8"))
    expect(saved.keys).toHaveLength(2)

    vi.mocked(console.log).mockClear()
    await wiki.parseAsync(["absorb-eval", "--dir", dir, "--n", "3", "--seed", "other", "--sample", sample, "--json"], { from: "user" })
    const { checks } = JSON.parse(String(vi.mocked(console.log).mock.calls[0][0]))
    expect(checks.map((c: { path: string }) => c.path)).toEqual(saved.keys)
  })
})
