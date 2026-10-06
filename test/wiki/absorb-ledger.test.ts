import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"

// The absorb command shells out to `claude`; the model's reply is the
// only thing these tests fake.
const { execSync } = vi.hoisted(() => ({ execSync: vi.fn() }))
vi.mock("child_process", async (orig) => ({ ...(await orig<typeof import("child_process")>()), execSync }))

import { wiki } from "../../src/commands/wiki"
import { WikiHub } from "../../src/wiki/hub"
import { ABSORB_LEDGER_FILE } from "../../src/wiki/absorb-ledger"

let dir: string

function seed(n: number): void {
  const store = new WikiHub(dir, () => {}).getSharedStore()
  for (let i = 1; i <= n; i++) {
    store.addEntry({ id: `e${i}`, date: `2026-09-${String(10 + i).padStart(2, "0")}`, agentId: "bench", source: "t", content: `entry ${i}` })
  }
}

function replyWith(articles: unknown[]): void {
  execSync.mockImplementationOnce(() => JSON.stringify({ result: JSON.stringify({ articles }) }))
}

async function absorb(...extra: string[]): Promise<void> {
  await wiki.parseAsync(["node", "wiki", "absorb", "--dir", dir, "--agent", "bench", "--no-facts", "--max", "2", ...extra])
}

/** Entry ids in the prompt the last run handed the model. */
const lastBatch = () =>
  [...readFileSync(resolve(dir, "agents/bench/graph/_tmp/absorb-prompt.txt"), "utf-8").matchAll(/--- ENTRY (\S+) /g)].map((m) => m[1])

const queue = () => new WikiHub(dir, () => {}).getUnabsorbedEntries("bench").map((e) => e.id)

describe("wiki absorb processed-entry ledger (#761)", () => {
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "wiki-absorb-"))
    execSync.mockReset()
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    seed(5)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it("moves forward across two runs when the model cites only part of a batch", async () => {
    replyWith([{ path: "a.md", title: "A", tags: [], content: "about e1", sources: ["e1"] }])
    await absorb()
    expect(lastBatch()).toEqual(["e1", "e2"])
    expect(queue()).toEqual(["e3", "e4", "e5"])

    replyWith([])
    await absorb()
    expect(lastBatch()).toEqual(["e3", "e4"])
    expect(queue()).toEqual(["e5"])

    const hub = new WikiHub(dir, () => {})
    expect(hub.getSkippedEntries("bench").map((e) => e.id)).toEqual(["e2", "e3", "e4"])
    expect(hub.summary().find((a) => a.agentId === "bench")).toMatchObject({ unabsorbed: 1, skipped: 3 })
  })

  it("marks nothing when the run fails", async () => {
    execSync.mockImplementationOnce(() => { throw Object.assign(new Error("claude exited 1"), { stdout: "" }) })
    await absorb()
    expect(queue()).toEqual(["e1", "e2", "e3", "e4", "e5"])
    expect(existsSync(resolve(dir, "agents/bench/graph", ABSORB_LEDGER_FILE))).toBe(false)
  })

  it("marks nothing when the reply has no usable JSON", async () => {
    execSync.mockImplementationOnce(() => JSON.stringify({ result: "I could not do that." }))
    await absorb()
    expect(queue()).toEqual(["e1", "e2", "e3", "e4", "e5"])
  })

  it("--reprocess brings skipped entries back, cited ones stay out", async () => {
    replyWith([{ path: "a.md", title: "A", tags: [], content: "about e1", sources: ["e1"] }])
    await absorb()

    replyWith([])
    await absorb("--reprocess")
    expect(lastBatch()).toEqual(["e2", "e3"])
    expect(queue()).toEqual(["e4", "e5"])
    expect(new WikiHub(dir, () => {}).getUnabsorbedEntries("bench", { reprocess: true }).map((e) => e.id))
      .toEqual(["e2", "e3", "e4", "e5"])
  })

  it("ignores a torn last ledger line", () => {
    const hub = new WikiHub(dir, () => {})
    hub.recordAbsorbed("bench", ["e1"], new Set())
    writeFileSync(resolve(dir, "agents/bench/graph", ABSORB_LEDGER_FILE), '{"entryId":"e1","agentId":"bench","processedAt":"x","outcome":"skipped"}\n{"entryId":"e2"')
    expect(queue()).toEqual(["e2", "e3", "e4", "e5"])
  })
})
