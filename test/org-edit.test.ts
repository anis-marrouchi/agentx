import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { applyOrgEdit, orgChoices, readOrgSetup } from "../src/business/org-edit"
import { businessConfigSchema } from "../src/business/config"
import { Organization } from "../src/business/organization"
import { handleAdminApi } from "../src/daemon/admin-panel"

// Editing the org chart from /org (#1420): members, roles and typed
// relations (#1418's model), checked before saving, owner only.

const schedule = { days: ["mon"], start: "08:00", end: "12:00" }

function base(): any {
  return {
    node: { id: "n", name: "n" },
    agents: { lead: { name: "Lead" }, pm: { name: "PM" }, dev: { name: "Dev" }, helper: { name: "Helper" } },
    people: [{ id: "sam", name: "Sam", role: "owner" }, { id: "kim", name: "Kim", role: "member" }],
    business: {
      roles: { boss: { title: "Chief" }, eng: { title: "Engineer" } },
      orgChart: {
        lead: { role: "boss", schedule, utilizationTarget: 0.5 },
        pm: { role: "eng", reportsTo: "lead", schedule, utilizationTarget: 0.8 },
      },
    },
  }
}

const org = (cfg: any) => new Organization(businessConfigSchema.parse(cfg.business), cfg.people)

describe("editing a chart that names a node no longer in mesh.peers (#1702)", () => {
  function retired(): any {
    const cfg = base()
    cfg.mesh = { peers: [] }
    cfg.business.relations = [{ from: "agent:old/seif", to: "agent:lead", type: "dotted-line" }]
    return cfg
  }

  it("lets an unrelated edit through", () => {
    const cfg = retired()
    expect(() => applyOrgEdit(cfg, { op: "add-member", member: "agent:dev", role: "Engineer" })).not.toThrow()
    expect(cfg.business.orgChart.dev).toBeDefined()
  })

  it("removes the ref to the retired node", () => {
    const cfg = retired()
    applyOrgEdit(cfg, { op: "remove-relation", from: "agent:old/seif", type: "dotted-line", to: "agent:lead" })
    expect(cfg.business.relations ?? []).toEqual([])
  })
})

describe("editing the org chart", () => {
  it("adds an agent with a new role, keeping each agent's schedule", () => {
    const cfg = base()
    expect(applyOrgEdit(cfg, { op: "add-member", member: "agent:dev", role: "Site reliability" })).toBe("Dev added to the org chart")
    expect(cfg.business.roles["site-reliability"]).toEqual({ title: "Site reliability" })
    expect(cfg.business.orgChart.dev).toMatchObject({ role: "site-reliability", schedule: { start: "09:00", end: "17:00" } })
    expect(cfg.business.orgChart.lead).toEqual({ role: "boss", schedule, utilizationTarget: 0.5 })
    // A role typed as an existing title reuses that role.
    applyOrgEdit(cfg, { op: "add-member", member: "agent:helper", role: "engineer" })
    expect(cfg.business.orgChart.helper.role).toBe("eng")
  })

  it("adds a person with a role, and makes them an agent's boss in orgChart reportsTo", () => {
    const cfg = base()
    applyOrgEdit(cfg, { op: "add-member", member: "person:sam", role: "Founder" })
    expect(cfg.business.orgPeople).toEqual({ sam: { role: "founder" } })
    expect(applyOrgEdit(cfg, { op: "add-relation", from: "agent:lead", type: "reports-to", to: "person:sam" })).toBe("Lead reports to Sam")
    expect(cfg.business.orgChart.lead.reportsTo).toBe("person:sam")
    expect(cfg.business.relations).toBeUndefined()
    // The business layer loads it: escalation stops below the person.
    expect(org(cfg).escalationChain("pm")).toEqual(["lead"])
    expect(org(cfg).reportsTo("lead")).toBe("person:sam")
  })

  it("writes dotted-line, acts-for and a person's own boss to business.relations", () => {
    const cfg = base()
    applyOrgEdit(cfg, { op: "add-member", member: "person:sam" })
    applyOrgEdit(cfg, { op: "add-member", member: "person:kim" })
    applyOrgEdit(cfg, { op: "add-relation", from: "agent:pm", type: "dotted-line", to: "person:sam" })
    applyOrgEdit(cfg, { op: "add-relation", from: "agent:lead", type: "acts-for", to: "person:sam" })
    applyOrgEdit(cfg, { op: "add-relation", from: "person:kim", type: "reports-to", to: "person:sam" })
    expect(cfg.business.relations).toEqual([
      { from: "agent:pm", to: "person:sam", type: "dotted-line" },
      { from: "agent:lead", to: "person:sam", type: "acts-for" },
      { from: "person:kim", to: "person:sam", type: "reports-to" },
    ])
    expect(businessConfigSchema.safeParse(cfg.business).success).toBe(true)
    expect(org(cfg).relations()).toHaveLength(4)
  })

  it("reads legacy reportsTo and people named only in relations as members", () => {
    const cfg = base()
    cfg.business.relations = [{ from: "pm", to: "person:kim", type: "dotted-line" }]
    const setup = readOrgSetup(cfg)
    expect(setup.members.map((m) => m.ref)).toEqual(["agent:lead", "agent:pm", "person:kim"])
    expect(setup.members[0]).toMatchObject({ name: "Lead", role: "boss", title: "Chief" })
    expect(setup.relations).toEqual([
      { from: "agent:pm", to: "agent:lead", type: "reports-to" },
      { from: "agent:pm", to: "person:kim", type: "dotted-line" },
    ])
  })

  it("changes a role", () => {
    const cfg = base()
    expect(applyOrgEdit(cfg, { op: "set-role", member: "agent:pm", role: "Chief" })).toBe("PM is now Chief")
    expect(cfg.business.orgChart.pm.role).toBe("boss")
    applyOrgEdit(cfg, { op: "add-member", member: "person:kim", role: "Advisor" })
    expect(applyOrgEdit(cfg, { op: "set-role", member: "person:kim", role: "" })).toBe("Kim has no role now")
    expect(cfg.business.orgPeople.kim).toEqual({})
    expect(() => applyOrgEdit(cfg, { op: "set-role", member: "agent:pm", role: " " })).toThrow("PM needs a role.")
  })

  it("removes a relation wherever it is written, and a member with every line it had", () => {
    const cfg = base()
    applyOrgEdit(cfg, { op: "add-member", member: "person:kim" })
    applyOrgEdit(cfg, { op: "add-relation", from: "agent:pm", type: "dotted-line", to: "person:kim" })
    applyOrgEdit(cfg, { op: "add-relation", from: "agent:lead", type: "acts-for", to: "person:kim" })
    expect(applyOrgEdit(cfg, { op: "remove-relation", from: "agent:pm", type: "reports-to", to: "agent:lead" })).toBe("PM no longer reports to Lead")
    expect(cfg.business.orgChart.pm.reportsTo).toBeUndefined()
    expect(applyOrgEdit(cfg, { op: "remove-member", member: "person:kim" })).toBe("Kim removed from the org chart, with 2 lines")
    expect(cfg.business.relations).toBeUndefined()
    expect(cfg.business.orgPeople).toBeUndefined()
    expect(applyOrgEdit(cfg, { op: "remove-member", member: "agent:lead" })).toBe("Lead removed from the org chart")
    expect(Object.keys(cfg.business.orgChart)).toEqual(["pm"])
    expect(() => applyOrgEdit(cfg, { op: "remove-relation", from: "agent:pm", type: "reports-to", to: "agent:lead" })).toThrow("not in the org chart any more")
  })

  describe("refuses, and changes nothing", () => {
    const refused = (cfg: any, edit: any, message: string) => {
      const before = JSON.stringify(cfg)
      expect(() => applyOrgEdit(cfg, edit)).toThrow(message)
      expect(JSON.stringify(cfg)).toBe(before)
    }

    it("a loop of reports-to lines, through a person too", () => {
      const cfg = base()
      refused(cfg, { op: "add-relation", from: "agent:lead", type: "reports-to", to: "agent:pm" }, "Lead cannot report to PM: PM already reports up to Lead.")
      applyOrgEdit(cfg, { op: "add-member", member: "person:sam" })
      applyOrgEdit(cfg, { op: "add-relation", from: "person:sam", type: "reports-to", to: "agent:pm" })
      refused(cfg, { op: "add-relation", from: "agent:lead", type: "reports-to", to: "person:sam" }, "Lead cannot report to Sam: Sam already reports up to Lead.")
    })

    it("a second reports-to", () => {
      const cfg = base()
      applyOrgEdit(cfg, { op: "add-member", member: "person:sam" })
      refused(cfg, { op: "add-relation", from: "agent:pm", type: "reports-to", to: "person:sam" }, "PM already reports to Lead. Remove that line first: each member has one boss.")
      // A dotted line is not a second boss.
      applyOrgEdit(cfg, { op: "add-relation", from: "agent:pm", type: "dotted-line", to: "person:sam" })
    })

    it("acts-for from a person, or to an agent", () => {
      const cfg = base()
      applyOrgEdit(cfg, { op: "add-member", member: "person:sam" })
      applyOrgEdit(cfg, { op: "add-member", member: "person:kim" })
      refused(cfg, { op: "add-relation", from: "person:sam", type: "acts-for", to: "person:kim" }, "Only an agent can act for someone: Sam is a person.")
      refused(cfg, { op: "add-relation", from: "agent:pm", type: "acts-for", to: "agent:lead" }, "An agent acts for a person: Lead is an agent.")
    })

    it("unknown members, people outside the chart, duplicates and a self line", () => {
      const cfg = base()
      refused(cfg, { op: "add-member", member: "agent:ghost", role: "x" }, 'There is no agent "ghost"')
      refused(cfg, { op: "add-member", member: "person:ghost" }, 'There is no person "ghost"')
      refused(cfg, { op: "add-member", member: "lead" }, "Pick an agent or a person")
      refused(cfg, { op: "add-member", member: "agent:dev" }, "Give Dev a role.")
      refused(cfg, { op: "add-member", member: "agent:pm", role: "eng" }, "PM is already in the org chart.")
      refused(cfg, { op: "add-relation", from: "agent:pm", type: "dotted-line", to: "person:kim" }, "Kim is not in the org chart. Add them first.")
      refused(cfg, { op: "add-relation", from: "agent:pm", type: "reports-to", to: "agent:pm" }, "PM cannot be linked to themself")
      refused(cfg, { op: "add-relation", from: "agent:pm", type: "reports-to", to: "agent:lead" }, "PM already reports to Lead.")
      refused(cfg, { op: "add-relation", from: "agent:pm", type: "boss-of", to: "agent:lead" }, '"boss-of" is not a kind of relation')
      refused(cfg, { op: "nope" }, "Unknown change")
    })

    it("removing a project's manager", () => {
      const cfg = base()
      cfg.business.projects = [{ id: "web", pm: "pm" }]
      refused(cfg, { op: "remove-member", member: "agent:pm" }, 'PM is the project manager of "web"')
    })
  })

  it("lets an edit through on a chart that was already broken, if it adds no new problem", () => {
    const cfg = base()
    cfg.business.relations = [{ from: "pm", to: "person:gone", type: "dotted-line" }]
    expect(applyOrgEdit(cfg, { op: "set-role", member: "agent:lead", role: "Engineer" })).toBe("Lead is now Engineer")
    // Removing the bad line fixes it.
    applyOrgEdit(cfg, { op: "remove-relation", from: "agent:pm", type: "dotted-line", to: "person:gone" })
    expect(cfg.business.relations).toBeUndefined()
  })

  it("offers known agents and listed people only, never an unlisted built-in owner", () => {
    const cfg = base()
    expect(orgChoices(cfg).people.map((p) => p.ref)).toEqual(["person:sam", "person:kim"])
    cfg.people = []
    expect(orgChoices(cfg).people).toEqual([])
    expect(() => applyOrgEdit(cfg, { op: "add-member", member: "person:owner" })).toThrow('There is no person "owner" in your people list.')
    expect(orgChoices(cfg).agents.map((a) => a.ref)).toEqual(["agent:lead", "agent:pm", "agent:dev", "agent:helper"])
  })
})

describe("the business layer takes a new chart without a restart", () => {
  it("swaps in place, and keeps the old chart when the new one is invalid", () => {
    const cfg = base()
    const o = org(cfg)
    expect(o.escalationChain("pm")).toEqual(["lead"])
    applyOrgEdit(cfg, { op: "remove-relation", from: "agent:pm", type: "reports-to", to: "agent:lead" })
    o.replaceWith(businessConfigSchema.parse(cfg.business), cfg.people)
    expect(o.escalationChain("pm")).toEqual([])
    const bad = businessConfigSchema.parse({ ...cfg.business, orgChart: { pm: { role: "missing", schedule } } })
    expect(() => o.replaceWith(bad, cfg.people)).toThrow("unknown role")
    expect(o.get("lead")).toBeDefined()
  })
})

describe("POST /api/admin/org/chart", () => {
  let dir: string
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-org-edit-"))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify(base()))
    process.chdir(dir)
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  async function call(method: string, path: string, body: unknown, owner?: boolean): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method }) as unknown as IncomingMessage
    let status = 200
    let out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, path, owner === undefined ? undefined : { owner })
    return { status, json: JSON.parse(out) }
  }
  const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
  const backups = () => readdirSync(dir).filter((f) => f.startsWith("agentx.json.bak."))

  it("saves for the owner, with a backup first", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      const r = await call("POST", "/api/admin/org/chart", { op: "add-member", member: "person:kim", role: "Advisor" }, true)
      expect(r).toMatchObject({ status: 200, json: { summary: "Kim added to the org chart" } })
      expect(existsSync(r.json.backupPath)).toBe(true)
      expect(JSON.parse(readFileSync(r.json.backupPath, "utf-8")).business.orgPeople).toBeUndefined()
      expect(saved().business.orgPeople).toEqual({ kim: { role: "advisor" } })
      const view = await call("GET", "/api/admin/org", undefined, true)
      expect(view.json.canEdit).toBe(true)
      expect(view.json.setup.members.map((m: any) => m.ref)).toEqual(["agent:lead", "agent:pm", "person:kim"])
      expect(view.json.choices.types).toEqual(["reports-to", "dotted-line", "acts-for"])
    } finally { fetchMock.mockRestore() }
  })

  it("refuses an invalid change with a plain message, and writes nothing", async () => {
    const r = await call("POST", "/api/admin/org/chart", { op: "add-relation", from: "agent:lead", type: "reports-to", to: "agent:pm" }, true)
    expect(r).toMatchObject({ status: 400, json: { error: "Lead cannot report to PM: PM already reports up to Lead." } })
    expect(saved()).toEqual(base())
    expect(backups()).toEqual([])
  })

  it("saves nothing that names an unlisted owner, so /org shows no \"not a person\" warning", async () => {
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ ...base(), people: [] }))
    const before = saved()
    const r = await call("POST", "/api/admin/org/chart", { op: "add-member", member: "person:owner", role: "Advisor" }, true)
    expect(r).toMatchObject({ status: 400, json: { error: 'There is no person "owner" in your people list. Add them on the People page first.' } })
    expect(saved()).toEqual(before)
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      const view = await call("GET", "/api/admin/org", undefined, true)
      expect(view.json.choices.people).toEqual([])
      expect(view.json.problem).toBeUndefined()
    } finally { fetchMock.mockRestore() }
  })

  it("is the owner's only: anyone else sees the chart and cannot change it", async () => {
    const vetoed = await call("POST", "/api/admin/org/chart", { op: "add-member", member: "person:kim" }, false)
    expect(vetoed).toMatchObject({ status: 403, json: { error: "Only the owner can change the org chart." } })
    expect((await call("POST", "/api/admin/org/chart", { op: "add-member", member: "person:kim" })).status).toBe(403)
    expect(saved()).toEqual(base())
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      const view = await call("GET", "/api/admin/org", undefined, false)
      expect(view.json).toMatchObject({ exists: true, canEdit: false })
      expect(view.json.choices).toBeUndefined()
      expect(view.json.roots.map((n: any) => n.id)).toEqual(["lead"])
    } finally { fetchMock.mockRestore() }
  })
})
