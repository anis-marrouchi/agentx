import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { business } from "../src/commands/business"
import { ORG_PEOPLE_JS } from "../src/daemon/ui/pages/org"

// `agentx business relation` and the Org page's people (#1418).

let dir: string
const schedule = { days: ["mon"], start: "09:00", end: "17:00" }
const prevCwd = process.cwd()
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentx-relation-"))
  process.chdir(dir)
  writeFileSync(join(dir, "agentx.json"), JSON.stringify({
    node: { id: "n", name: "n" },
    agents: { pm: { name: "PM", workspace: join(dir, "pm") }, dev: { name: "Dev", workspace: join(dir, "dev") } },
    people: [{ id: "sam", name: "Sam" }, { id: "kim", name: "Kim" }],
    business: { orgChart: { pm: { role: "PM", schedule }, dev: { role: "Dev", reportsTo: "pm", schedule } } },
  }))
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(prevCwd)
  rmSync(dir, { recursive: true, force: true })
})

const run = (...args: string[]) => business.parseAsync(args, { from: "user" })
const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8")).business.relations

describe("agentx business relation", () => {
  it("adds a relation written in full, and removes it", async () => {
    await run("relation", "add", "pm", "reports-to", "person:sam")
    await run("relation", "add", "agent:dev", "dotted-line", "person:kim")
    expect(saved()).toEqual([
      { from: "agent:pm", to: "person:sam", type: "reports-to" },
      { from: "agent:dev", to: "person:kim", type: "dotted-line" },
    ])
    await run("relation", "rm", "agent:pm", "reports-to", "person:sam")
    expect(saved()).toEqual([{ from: "agent:dev", to: "person:kim", type: "dotted-line" }])
  })

  it("refuses an unknown person or a broken rule, and saves nothing", async () => {
    await expect(run("relation", "add", "agent:pm", "reports-to", "person:nobody")).rejects.toThrow(/not a person in people/)
    await expect(run("relation", "add", "person:sam", "acts-for", "agent:pm")).rejects.toThrow(/acts-for goes from an agent to a person/)
    await expect(run("relation", "add", "agent:dev", "reports-to", "person:sam")).rejects.toThrow(/reports to both/)
    expect(saved()).toBeUndefined()
  })

  it("refuses a relation type it does not know", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    await run("relation", "add", "agent:pm", "manages", "agent:dev")
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
    expect(saved()).toBeUndefined()
  })

  it("lists orgChart reportsTo with the relations", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await run("relation", "list", "--json")
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toEqual({
      relations: [{ from: "agent:dev", to: "agent:pm", type: "reports-to" }],
    })
  })

  it("says when removing a relation that is not there", async () => {
    await expect(run("relation", "remove", "agent:dev", "reports-to", "agent:pm")).rejects.toThrow(/orgchart add/)
  })
})

describe("Org page people", () => {
  const withPeople = new Function(`${ORG_PEOPLE_JS}; return withPeople`)() as (d: any) => { roots: any[]; names: Record<string, string> }
  const agent = (id: string, reportsTo?: string, reports: any[] = []) => ({ id, name: id.toUpperCase(), ...(reportsTo ? { reportsTo } : {}), reports })

  it("puts a person above the agents that report to them, with links on the cards", () => {
    const dev = agent("dev", "pm")
    const pm = agent("pm", "person:sam", [dev])
    const out = withPeople({
      roots: [pm],
      outside: [],
      people: [{ id: "sam", name: "Sam" }, { id: "kim", name: "Kim" }, { id: "lee", name: "Lee" }],
      relations: [
        { from: "agent:dev", to: "agent:pm", type: "reports-to" },
        { from: "agent:pm", to: "person:sam", type: "reports-to" },
        { from: "agent:dev", to: "person:kim", type: "dotted-line" },
        { from: "agent:pm", to: "person:sam", type: "acts-for" },
        { from: "person:kim", to: "person:sam", type: "reports-to" },
      ],
    })
    expect(out.roots.map((n) => n.id)).toEqual(["sam"])
    const sam = out.roots[0]
    expect(sam.kind).toBe("person")
    expect(sam.reports.map((n: any) => n.id)).toEqual(["pm", "kim"])
    expect(dev.dottedLine).toEqual(["person:kim"])
    expect(pm.actsFor).toEqual(["person:sam"])
    // Lee is in no relation, so has no card.
    expect(out.names["person:lee"]).toBe("Lee")
  })

  it("gives a person placed in the chart with no line a card with their role (#1432)", () => {
    const out = withPeople({
      roots: [agent("pm")],
      people: [{ id: "sam", name: "Sam", placed: true, title: "Engineer" }, { id: "lee", name: "Lee" }],
      relations: [],
    })
    expect(out.roots.map((n) => [n.id, n.title])).toEqual([["pm", undefined], ["sam", "Engineer"]])
  })

  it("draws a loop between a person and an agent without nesting it forever", () => {
    const pm = agent("pm", "person:sam")
    const out = withPeople({
      roots: [pm],
      people: [{ id: "sam", name: "Sam" }],
      relations: [
        { from: "agent:pm", to: "person:sam", type: "reports-to" },
        { from: "person:sam", to: "agent:pm", type: "reports-to" },
      ],
    })
    expect(out.roots.map((n) => n.id)).toEqual(["sam"])
    expect(out.roots[0].reports).toEqual([pm])
    expect(pm.reports).toEqual([])
  })
})
