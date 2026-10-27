import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema } from "../src/daemon/config"
import { businessConfigSchema } from "../src/business/config"
import { holdAgent, holdIfAgentCreated, holdMessage, holdsRoot, readHolds, releaseAgent } from "../src/agents/holds"
import { buildOrgView, firstLine } from "../src/business/org-view"
import { decide, listInbox } from "../src/approvals/inbox"
import { handleAdminApi } from "../src/daemon/admin-panel"
import { renderOrgPage } from "../src/daemon/ui/pages/org"

// Org view and owner approval for new agents (#1169).

let dir: string
const prevCwd = process.cwd()
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-org-")) })
afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

const config = {
  agents: {
    ceo: { name: "Chief", systemPrompt: "You run the company. You decide." },
    pm: { name: "PM", systemPrompt: "Plans." },
    dev: { name: "Dev", systemPrompt: "Writes code for the team, with tests, in small merge requests that a reviewer can read in one sitting without scrolling far." },
    qa: { name: "QA" },
    newbie: { name: "Newbie", systemPrompt: "Helps." },
  },
  business: {
    roles: {
      lead: { title: "Chief executive", responsibilities: ["Sets goals each week. Approves budgets."] },
      pm: { title: "Project manager", responsibilities: [] },
      eng: { title: "Engineer" },
    },
    orgChart: {
      ceo: { role: "lead" },
      pm: { role: "pm", reportsTo: "ceo" },
      dev: { role: "eng", reportsTo: "pm" },
      qa: { role: "eng", reportsTo: "pm" },
    },
  },
}

describe("the org tree", () => {
  it("draws reporting lines with role, job and status, and lists agents outside the chart", () => {
    const view = buildOrgView(config, { qa: { kind: "paused", at: "t", by: "the owner" } }, [{ id: "ceo", active: 0 }, { id: "pm", active: 2 }, { id: "dev", active: 0 }])
    expect(view.live).toBe(true)
    expect(view.roots.map((n) => n.id)).toEqual(["ceo"])
    const [ceo] = view.roots
    expect(ceo).toMatchObject({ name: "Chief", title: "Chief executive", job: "Sets goals each week.", status: "idle" })
    expect(ceo.reports.map((n) => n.id)).toEqual(["pm"])
    const pm = ceo.reports[0]
    expect(pm).toMatchObject({ title: "Project manager", job: "Plans.", status: "working", active: 2, reportsTo: "ceo" })
    expect(pm.reports.map((n) => [n.id, n.status])).toEqual([["dev", "idle"], ["qa", "paused"]])
    expect(pm.reports[1].heldBy).toBe("the owner")
    expect(view.outside.map((n) => [n.id, n.status])).toEqual([["newbie", "unknown"]])
  })

  it("says unknown without the daemon, waiting for an agent another agent made, and survives a loop", () => {
    const loop = { ...config, business: { ...config.business, orgChart: { ceo: { role: "lead", reportsTo: "pm" }, pm: { role: "pm", reportsTo: "ceo" } } } }
    const view = buildOrgView(loop, { pm: { kind: "approval", at: "t", by: "ceo" } }, null)
    expect(view.live).toBe(false)
    expect(view.roots.map((n) => [n.id, n.status])).toEqual([["ceo", "unknown"], ["pm", "waiting"]])
    expect(view.roots[1].heldBy).toBe("ceo")
  })

  it("returns people and typed relations, a person boss putting the agent at the top (#1418)", () => {
    const withPeople = {
      ...config,
      people: [{ id: "owner", name: "The Owner", identities: ["telegram:1"] }],
      business: {
        ...config.business,
        orgChart: { ...config.business.orgChart, ceo: { role: "lead", reportsTo: "person:owner" } },
        relations: [{ from: "dev", to: "person:owner", type: "acts-for" }],
      },
    }
    const view = buildOrgView(withPeople, {}, null)
    expect(view.people).toEqual([{ id: "owner", name: "The Owner" }])
    expect(view.relations).toContainEqual({ from: "agent:ceo", to: "person:owner", type: "reports-to" })
    expect(view.relations).toContainEqual({ from: "agent:pm", to: "agent:ceo", type: "reports-to" })
    expect(view.relations).toContainEqual({ from: "agent:dev", to: "person:owner", type: "acts-for" })
    expect(view.problem).toBeUndefined()
    expect(view.roots.map((n) => [n.id, n.reportsTo])).toEqual([["ceo", "person:owner"]])
    const bad = buildOrgView({ ...withPeople, people: [] }, {}, null)
    expect(bad.problem).toMatch(/"owner", which is not a person/)
  })

  it("cuts a long job to one short line", () => {
    expect(firstLine("  Many\n spaces.  Second.")).toBe("Many spaces.")
    expect(firstLine("x".repeat(300))!.length).toBe(140)
    expect(firstLine("")).toBeUndefined()
  })
})

describe("an org chart on its own", () => {
  it("is a valid business block: no main channel needed until the business layer is on", () => {
    const orgOnly = { orgChart: { ceo: { role: "Chief", schedule: { start: "09:00", end: "17:00" } } } }
    const parsed = businessConfigSchema.safeParse(orgOnly)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.workSource).toEqual({ type: "backlog", path: ".agentx/backlog.md" })
    const on = businessConfigSchema.safeParse({ ...orgOnly, enabled: true })
    expect(on.success).toBe(false)
    expect(!on.success && on.error.issues[0]).toMatchObject({ path: ["mainChannel"] })
    expect(businessConfigSchema.safeParse({ ...orgOnly, enabled: true, mainChannel: { channel: "telegram", chatId: "1" } }).success).toBe(true)
  })
})

describe("holds", () => {
  it("pause and resume apply at once; resume does not approve a new agent", () => {
    holdAgent(dir, "dev", "paused", "the owner")
    expect(holdMessage(dir, "dev")).toContain("paused by the owner")
    holdAgent(dir, "newbie", "approval", "ceo")
    expect(holdMessage(dir, "newbie")).toContain("created by ceo")
    expect(releaseAgent(dir, "newbie", "paused")).toBe(false)
    expect(releaseAgent(dir, "dev", "paused")).toBe(true)
    expect(Object.keys(readHolds(dir))).toEqual(["newbie"])
    expect(holdMessage(dir, "dev")).toBeNull()
  })

  it("holds agents created from an agent's shell, and nothing the owner creates", () => {
    expect(holdIfAgentCreated(dir, ["a", "b"], {})).toBeUndefined()
    expect(existsSync(join(dir, ".agentx", "agent-holds.json"))).toBe(false)
    expect(holdIfAgentCreated(dir, ["a", "b"], { AGENTX_AGENT_ID: "ceo" })).toBe("ceo")
    expect(readHolds(dir)).toMatchObject({ a: { kind: "approval", by: "ceo" }, b: { kind: "approval", by: "ceo" } })
  })

  it("a held agent starts no run, for any caller", async () => {
    process.chdir(dir)
    const r = new AgentRegistry(daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { dev: { name: "Dev", workspace: dir } } }), () => {})
    holdAgent(dir, "dev", "approval", "ceo")
    const out = await r.execute({ message: "hi", agentId: "dev" })
    expect(out).toMatchObject({ errorKind: "agent_held" })
    expect(out.error).toContain("waits for the owner's approval")
  })

  it("with the config at .agentx/config.json, the daemon still sees a hold made by agent or team add", async () => {
    mkdirSync(join(dir, ".agentx"))
    writeFileSync(join(dir, ".agentx", "config.json"), "{}")
    process.chdir(dir)
    holdIfAgentCreated(holdsRoot(), ["dev"], { AGENTX_AGENT_ID: "ceo" })
    expect(existsSync(join(dir, ".agentx", ".agentx"))).toBe(false)
    const r = new AgentRegistry(daemonConfigSchema.parse({ node: { id: "n", name: "n" }, agents: { dev: { name: "Dev", workspace: dir } } }), () => {})
    expect(await r.execute({ message: "hi", agentId: "dev" })).toMatchObject({ errorKind: "agent_held" })
    // Both commands hold through the same root, not the config file's folder.
    for (const file of ["src/commands/manage.ts", "src/commands/team.ts"]) {
      const src = readFileSync(join(prevCwd, file), "utf-8")
      expect(src).toContain("holdIfAgentCreated(holdsRoot(),")
      expect(src).not.toMatch(/holdIfAgentCreated\((?!holdsRoot\(\))/)
    }
  })
})

describe("a new agent waits on a card until the owner approves it", () => {
  function setup() {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({
      node: { id: "n", name: "n" },
      agents: { ceo: { name: "Chief", workspace: join(dir, "ceo") }, helper: { name: "Helper", tier: "claude-code", workspace: join(dir, "helper"), systemPrompt: "Answers mail." } },
      crons: { "helper-daily": { schedule: "0 9 * * *", agent: "helper", prompt: "Sum up." }, "ceo-daily": { schedule: "0 9 * * *", agent: "ceo", prompt: "Plan." } },
    }))
    holdIfAgentCreated(dir, ["helper"], { AGENTX_AGENT_ID: "ceo" })
  }

  it("is listed for the owner, and yes lets it run", async () => {
    setup()
    const { items } = listInbox({ root: dir }, { kinds: ["agent"] })
    expect(items).toEqual([expect.objectContaining({ key: "agent:helper", kind: "agent", title: 'New agent "Helper", created by ceo', raised_by: "ceo" })])
    expect(items[0].detail).toContain("Answers mail.")
    const r = await decide({ root: dir, reload: false }, "agent:helper", "yes")
    expect(r).toMatchObject({ ok: true })
    expect(holdMessage(dir, "helper")).toBeNull()
    expect(listInbox({ root: dir }, { kinds: ["agent"] }).items).toEqual([])
  })

  it("no removes it and the schedules that came with it from agentx.json", async () => {
    setup()
    const r = await decide({ root: dir, reload: false }, "agent:helper", "no")
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("with its schedules helper-daily") })
    const cfg = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    expect(Object.keys(cfg.agents)).toEqual(["ceo"])
    expect(Object.keys(cfg.crons)).toEqual(["ceo-daily"])
    expect(readHolds(dir)).toEqual({})
    expect(await decide({ root: dir, reload: false }, "agent:helper", "yes")).toMatchObject({ ok: false })
  })
})

describe("the Org page and its API", () => {
  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method }) as unknown as IncomingMessage
    let status = 200
    let out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, path)
    return { status, json: JSON.parse(out) }
  }

  it("serves the tree, and pauses and resumes from a card", async () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ node: { id: "n", name: "n" }, ...config }))
    process.chdir(dir)
    // The daemon: down, then up with pm busy. Never this machine's real one.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"))
    try {
      const down = await call("GET", "/api/admin/org")
      expect(down.json).toMatchObject({ exists: true, live: false })
      expect(down.json.roots[0]).toMatchObject({ id: "ceo", status: "unknown" })
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ id: "ceo", active: 0 }, { id: "pm", active: 1 }])))
      const up = await call("GET", "/api/admin/org")
      expect(up.json.live).toBe(true)
      expect(up.json.roots[0].reports[0]).toMatchObject({ id: "pm", status: "working" })
    } finally { fetchMock.mockRestore() }

    expect((await call("POST", "/api/admin/org/hold", { agent: "dev", paused: true })).json.summary).toContain("paused")
    expect(readHolds(dir).dev).toMatchObject({ kind: "paused", by: "the owner" })
    await call("POST", "/api/admin/org/hold", { agent: "dev", paused: false })
    expect(readHolds(dir).dev).toBeUndefined()

    holdAgent(dir, "newbie", "approval", "ceo")
    expect((await call("POST", "/api/admin/org/hold", { agent: "newbie", paused: false })).status).not.toBe(200)
    expect(readHolds(dir).newbie).toBeDefined()
  })

  it("ships a script that parses", () => {
    const html = renderOrgPage({})
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(html).toContain('id="org-tree"')
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })
})
