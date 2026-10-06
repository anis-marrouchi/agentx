import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { WikiHub } from "../src/wiki/hub"
import { absorbLedgerPath, readAbsorbLedger } from "../src/wiki/absorb-ledger"
import { wiki } from "../src/commands/wiki"

// #761: entries absorb read and chose not to cite stayed unabsorbed
// forever and came back at the head of every run.
//
// The runs go through the real `wiki absorb` command against a stand-in
// `claude` on PATH. It cites the first entry in each batch, or prints no
// JSON at all when FAKE_CLAUDE_FAIL is set.

let dir: string
let wikiRoot: string
const prevCwd = process.cwd()
const prevPath = process.env.PATH

const FAKE_CLAUDE = `#!/usr/bin/env node
const input = require("fs").readFileSync(0, "utf-8")
if (process.env.FAKE_CLAUDE_FAIL) { process.stdout.write("rate limited"); process.exit(0) }
const ids = [...input.matchAll(/--- ENTRY (\\S+) /g)].map((m) => m[1])
const article = { path: "notes/" + ids[0] + ".md", title: "Note " + ids[0], tags: [], type: "concept", content: "Body.", sources: [ids[0]] }
process.stdout.write(JSON.stringify({ result: JSON.stringify({ articles: [article], gaps: [] }) }))
`

function seed(n: number): string[] {
  const store = new WikiHub(wikiRoot, () => {}).getSharedStore()
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const id = `e${String(i).padStart(2, "0")}`
    store.addEntry({ id, date: `2026-09-${String(10 + i).padStart(2, "0")}`, agentId: "ops", source: "chat", content: `entry ${i}` })
    ids.push(id)
  }
  return ids
}

async function absorb(...extra: string[]): Promise<void> {
  await wiki.parseAsync(["absorb", "--dir", wikiRoot, "--agent", "ops", "--no-facts", "--max", "3", ...extra], { from: "user" })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-absorb-ledger-"))
  wikiRoot = resolve(dir, ".agentx/wiki")
  process.chdir(dir)
  const bin = resolve(dir, "bin")
  mkdirSync(bin)
  writeFileSync(resolve(bin, "claude"), FAKE_CLAUDE)
  chmodSync(resolve(bin, "claude"), 0o755)
  process.env.PATH = `${bin}:${prevPath}`
  delete process.env.FAKE_CLAUDE_FAIL
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  process.env.PATH = prevPath
  delete process.env.FAKE_CLAUDE_FAIL
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("wiki absorb ledger", () => {
  it("moves forward through the backlog across back-to-back runs", async () => {
    const ids = seed(7)
    const hub = () => new WikiHub(wikiRoot, () => {})

    await absorb()
    expect(hub().getUnabsorbedEntries("ops").map((e) => e.id)).toEqual(ids.slice(3))
    expect(hub().getSkippedEntries("ops").map((e) => e.id)).toEqual(["e01", "e02"])

    await absorb()
    // Run 2 read e03..e05, not the uncited e01/e02 again.
    expect(hub().getUnabsorbedEntries("ops").map((e) => e.id)).toEqual(["e06"])

    const ledger = readAbsorbLedger(wikiRoot, "ops", "graph")
    expect(Object.fromEntries(ledger)).toEqual({
      e00: "cited", e01: "skipped", e02: "skipped",
      e03: "cited", e04: "skipped", e05: "skipped",
    })

    const summary = hub().summary().find((s) => s.agentId === "ops")!
    expect(summary.unabsorbed).toBe(1)
    expect(summary.skipped).toBe(4)
  })

  it("does not mark entries processed when the run fails", async () => {
    seed(4)
    process.env.FAKE_CLAUDE_FAIL = "1"
    await absorb()
    expect(existsSync(absorbLedgerPath(wikiRoot))).toBe(false)
    expect(new WikiHub(wikiRoot, () => {}).getUnabsorbedEntries("ops")).toHaveLength(4)
  })

  it("keeps the ledger per mode", async () => {
    seed(3)
    await absorb()
    expect(new WikiHub(wikiRoot, () => {}, "graph").getUnabsorbedEntries("ops")).toHaveLength(0)
    expect(new WikiHub(wikiRoot, () => {}, "flat").getUnabsorbedEntries("ops")).toHaveLength(3)
  })

  it("brings skipped entries back with includeProcessed (--reprocess)", async () => {
    seed(3)
    await absorb()
    const hub = new WikiHub(wikiRoot, () => {})
    expect(hub.getUnabsorbedEntries("ops")).toHaveLength(0)
    expect(hub.getUnabsorbedEntries("ops", { includeProcessed: true }).map((e) => e.id)).toEqual(["e01", "e02"])

    await absorb("--reprocess")
    const lines = readFileSync(absorbLedgerPath(wikiRoot), "utf-8").trim().split("\n")
    // Second run re-read e01 and e02 and cited e01 this time.
    expect(lines).toHaveLength(5)
    expect(readAbsorbLedger(wikiRoot, "ops", "graph").get("e01")).toBe("cited")
  })
})
