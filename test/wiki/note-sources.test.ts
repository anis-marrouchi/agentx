import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"

import { parseNote, readNotes } from "../../src/wiki/note-reader"
import { absorbOffAgents, selectAbsorbAgents, setWikiAbsorb } from "../../src/wiki/absorb-agents"
import { AgentMemory } from "../../src/agents/agent-memory"
import { daemonConfigSchema } from "../../src/daemon/config"
import { WikiHub } from "../../src/wiki/hub"

// #850: the pieces that do not depend on the open design decisions — the
// note reader for either notes folder, and leaving an agent out of the
// bulk absorb.

let dir: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-note-sources-"))
  cwd = process.cwd()
})

afterEach(() => {
  process.chdir(cwd)
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function write(folder: string, file: string, text: string): void {
  mkdirSync(folder, { recursive: true })
  writeFileSync(resolve(folder, file), text)
}

describe("note reader", () => {
  it("reads source and checked from the AgentX store layout", () => {
    const store = new AgentMemory({ baseDir: dir })
    store.save({ agentId: "agent-a", type: "project", name: "billing-cutoff", description: "Invoices close on the 25th", body: "The billing run closes invoices on the 25th." })
    // The store keeps unknown fields out; a person or tool adds the two
    // fields to the file by hand.
    const folder = store.dirOf("agent-a")
    const file = resolve(folder, "project_billing_cutoff.md")
    writeFileSync(file, readFileSync(file, "utf-8").replace("type: project\n", "type: project\nsource: billing app settings\nchecked: 2026-10-01\n"))

    const read = readNotes(folder)
    expect(read.notes).toHaveLength(1)
    const n = read.notes[0]
    expect(n).toMatchObject({
      name: "billing_cutoff", file: "project_billing_cutoff.md", type: "project",
      description: "Invoices close on the 25th", source: "billing app settings", checked: "2026-10-01", missing: [],
    })
    expect(n.body).toBe("The billing run closes invoices on the 25th.")
    expect(n.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("reads a notes folder kept by another tool, with the fields under metadata", () => {
    const folder = resolve(dir, "notes")
    write(folder, "deploy-host.md", [
      "---",
      "name: deploy-host",
      "description: \"Staging deploys go to the blue pool: since the move\"",
      "type: reference",
      "metadata:",
      "  source: deploy runbook",
      "  checked: 2026-09-30T08:15:00Z",
      "---",
      "",
      "Staging deploys go to the blue pool.",
    ].join("\n"))
    write(folder, "MEMORY.md", "- [deploy-host](deploy-host.md) — index line\n")
    write(folder, "notes.txt", "not a note")
    mkdirSync(resolve(folder, "_versions"), { recursive: true })

    const read = readNotes(folder)
    expect(read.notes.map((n) => n.name)).toEqual(["deploy-host"])
    expect(read.notes[0]).toMatchObject({
      description: "Staging deploys go to the blue pool: since the move",
      source: "deploy runbook", checked: "2026-09-30", missing: [], problems: [],
    })
  })

  it("names what a note lacks instead of guessing it from the prose", () => {
    const n = parseNote("---\nname: office-hours\ndescription: Front desk hours\ntype: project\n---\nChecked with the front desk on 2026-10-02: open 9 to 5.\n", "office-hours.md")!
    expect(n.missing).toEqual(["source", "checked"])
    expect(n.source).toBeUndefined()
    expect(n.checked).toBeUndefined()
  })

  it("reports a check date it cannot read", () => {
    const bad = parseNote("---\nname: a\ndescription: d\nsource: s\nchecked: last week\n---\nbody\n", "a.md")!
    expect(bad.missing).toEqual(["checked"])
    expect(bad.problems).toEqual(["checked \"last week\" is not a date (use YYYY-MM-DD)"])
    expect(parseNote("---\nname: a\ndescription: d\nsource: s\nchecked: 2026-02-30\n---\nbody\n", "a.md")!.missing).toEqual(["checked"])
  })

  it("lets a top-level field win over the same field under metadata", () => {
    const n = parseNote("---\nname: a\ndescription: d\nsource: top\nmetadata:\n  source: nested\n  checked: 2026-10-03\n---\nbody\n", "a.md")!
    expect(n).toMatchObject({ source: "top", checked: "2026-10-03", missing: [] })
  })

  it("reads a file without frontmatter as a note with nothing checked", () => {
    const n = parseNote("# Parking\n\nVisitors park on level 2.\n", "parking.md")!
    expect(n).toMatchObject({ name: "parking", description: "Parking", missing: ["source", "checked"] })
    expect(parseNote("", "empty.md")).toBeNull()
  })

  it("reads a missing folder as empty", () => {
    expect(readNotes(resolve(dir, "nope"))).toEqual({ dir: resolve(dir, "nope"), notes: [], skipped: [] })
  })

  it("memory check lists each note and counts the complete ones", async () => {
    const folder = resolve(dir, "notes")
    write(folder, "a.md", "---\nname: a\ndescription: d\nsource: s\nchecked: 2026-10-01\n---\nbody\n")
    write(folder, "b.md", "---\nname: b\ndescription: d\n---\nbody\n")
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")) })
    const { memory } = await import("../../src/commands/memory")

    // Commander keeps option values between parses: text first, then JSON.
    await memory.parseAsync(["check", "--agent", "agent-a", "--dir", folder, "--missing"], { from: "user" })
    const text = lines.join("\n")
    expect(text).toContain("no source, no checked")
    expect(text).not.toContain("✓")
    expect(text).toContain("1 of 2 note(s) have both a source and a check date.")

    lines.length = 0
    await memory.parseAsync(["check", "--agent", "agent-a", "--dir", folder, "--missing", "--json"], { from: "user" })
    const out = JSON.parse(lines.join("\n"))
    expect(out).toMatchObject({ agent: "agent-a", complete: 1, total: 2 })
    expect(out.notes.map((n: { name: string; missing: string[] }) => [n.name, n.missing])).toEqual([["b", ["source", "checked"]]])
  })
})

describe("agents.<id>.wiki.absorb.enabled", () => {
  it("is on by default and can be turned off per agent", () => {
    const cfg = daemonConfigSchema.parse({
      node: { id: "n", name: "N" },
      agents: {
        "agent-a": { name: "A", workspace: "/w", wiki: {} },
        "agent-b": { name: "B", workspace: "/w", wiki: { absorb: { enabled: false } } },
        "agent-c": { name: "C", workspace: "/w" },
      },
    })
    expect(cfg.agents["agent-a"].wiki?.absorb.enabled).toBe(true)
    expect(cfg.agents["agent-b"].wiki?.absorb.enabled).toBe(false)
    expect([...absorbOffAgents(cfg.agents)]).toEqual(["agent-b"])
  })

  it("skips an agent with absorb off, unless it is named", () => {
    const off = new Set(["agent-b"])
    expect(selectAbsorbAgents(["agent-a", "agent-b", "agent-c"], { off })).toEqual({ agents: ["agent-a", "agent-c"], skipped: ["agent-b"] })
    expect(selectAbsorbAgents(["agent-a", "agent-b"], { only: "agent-b", off })).toEqual({ agents: ["agent-b"], skipped: [] })
    expect(selectAbsorbAgents(["agent-a"], { off: new Set() })).toEqual({ agents: ["agent-a"], skipped: [] })
  })

  it("wiki absorb names the skipped agent and still reads the others; --agent forces it", async () => {
    const wikiDir = resolve(dir, "wiki")
    const hub = new WikiHub(wikiDir, () => {})
    for (const agent of ["agent-a", "agent-b"]) {
      hub.getSharedStore().addEntry({ id: `e-${agent}`, date: "2026-10-08", agentId: agent, source: "telegram", content: `work by ${agent}` })
    }
    writeFileSync(resolve(dir, "agentx.json"), JSON.stringify({
      node: { id: "n", name: "N" },
      agents: {
        "agent-a": { name: "A", workspace: "/w" },
        "agent-b": { name: "B", workspace: "/w", wiki: { absorb: { enabled: false } } },
      },
    }))
    process.chdir(dir)
    const lines: string[] = []
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")) })
    const { wiki } = await import("../../src/commands/wiki")

    await wiki.parseAsync(["absorb", "--dir", wikiDir, "--dry-run", "--model", "sonnet"], { from: "user" })
    let text = lines.join("\n")
    expect(text).toMatch(/agent-b.*absorb is off for this agent/)
    expect(text).toMatch(/agent-a.*1 entries to absorb/)
    expect(text).not.toMatch(/agent-b.*entries to absorb/)

    lines.length = 0
    await wiki.parseAsync(["absorb", "--dir", wikiDir, "--dry-run", "--model", "sonnet", "--agent", "agent-b"], { from: "user" })
    text = lines.join("\n")
    expect(text).not.toMatch(/absorb is off/)
    expect(text).toMatch(/agent-b.*1 entries to absorb/)
  })

  it("the dashboard writes only false, and turning it on removes the key", () => {
    const a: { name: string; wiki?: any } = { name: "A" }
    setWikiAbsorb(a, true)
    expect(a).toEqual({ name: "A" })
    setWikiAbsorb(a, false)
    expect(a.wiki).toEqual({ absorb: { enabled: false } })
    setWikiAbsorb(a, true)
    expect(a).toEqual({ name: "A" })
    const b = { wiki: { contribute: { enabled: true }, absorb: { enabled: false } } }
    setWikiAbsorb(b, true)
    expect(b).toEqual({ wiki: { contribute: { enabled: true } } })
  })

  it("is on the agent page and the dashboard's Edit agent dialog", () => {
    const page = readFileSync(resolve(__dirname, "../../src/daemon/ui/pages/agent.ts"), "utf-8")
    expect(page).toContain('data-field="wikiAbsorb"')
    expect(page).toContain("body.wikiAbsorb = $('f-wabs').value === 'on'")
    const agentPanel = readFileSync(resolve(__dirname, "../../src/daemon/agent-panel.ts"), "utf-8")
    expect(agentPanel).toContain("setWikiAbsorb(cfg.agents[agentId], body.wikiAbsorb)")
    const ui = readFileSync(resolve(__dirname, "../../src/daemon/ui/pages/admin.ts"), "utf-8")
    expect(ui).toContain('id="e-wiki-absorb"')
    expect(ui).toContain("wikiAbsorb: $('e-wiki-absorb').checked")
    const panel = readFileSync(resolve(__dirname, "../../src/daemon/admin-panel.ts"), "utf-8")
    expect(panel).toContain("wikiAbsorb: a.wiki?.absorb?.enabled !== false")
  })
})
