import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import type { IncomingMessage, ServerResponse } from "http"
import { handleAdminApi } from "../src/daemon/admin-panel"
import { businessConfigSchema } from "../src/business/config"
import { Organization } from "../src/business/organization"
import { agentClients } from "../src/business/clients"
import { leadKey, orgProjects, projectsProblem } from "../src/business/org-projects"
import { buildOrgView } from "../src/business/org-view"
import { business } from "../src/commands/business"
import { renderOrgPage } from "../src/daemon/ui/pages/org"
import { ORG_PROJECTS_JS } from "../src/daemon/ui/pages/org-projects"

// The Org page's Projects view: each project with its manager and team (#1687).

const schedule = { days: ["mon"], start: "09:00", end: "17:00" }
const config = {
  agents: { pm: { name: "PM" }, dev: { name: "Dev" }, ops: { name: "Ops" }, sales: { name: "Sales" } },
  people: [{ id: "sam", name: "Sam Demo", role: "owner" }, { id: "kim", name: "Kim" }],
  business: {
    orgChart: { pm: { reportsTo: "person:sam" }, dev: { reportsTo: "pm" }, ops: { reportsTo: "pm" }, sales: { reportsTo: "person:sam" } },
    relations: [{ from: "person:kim", to: "person:sam", type: "reports-to" as const }],
    projects: [
      { id: "globex/site", name: "Globex website", pm: "pm", lead: "person:sam", team: ["dev", "agent:ops", "person:kim", "dev", "pm"] },
      { id: "acme/app", pm: "pm" },
    ],
  },
}

describe("business.projects name, team and lead", () => {
  it("are optional in the schema; a project with only pm parses as before", () => {
    const old = businessConfigSchema.parse({ projects: [{ id: "a/b", pm: "pm" }] })
    expect(old.projects[0]).toEqual({ id: "a/b", pm: "pm" })
    const full = businessConfigSchema.parse({ projects: [{ id: "a/b", pm: "pm", name: "B", lead: "person:sam", team: ["dev"] }] })
    expect(full.projects[0]).toEqual({ id: "a/b", pm: "pm", name: "B", lead: "person:sam", team: ["dev"] })
    expect(() => businessConfigSchema.parse({ projects: [{ id: "a/b", team: [""] }] })).toThrow()
  })

  it("writes refs in full, without repeats, sorted by client then name", () => {
    expect(orgProjects(config.business)).toEqual([
      { id: "acme/app", name: "acme/app", client: "acme", pm: "agent:pm", team: [] },
      { id: "globex/site", name: "Globex website", client: "globex", pm: "agent:pm", lead: "person:sam", team: ["agent:dev", "agent:ops", "person:kim", "agent:pm"] },
    ])
    expect(orgProjects(undefined)).toEqual([])
    // A bare lead is a person; an explicit client wins over the id.
    expect(leadKey("sam")).toBe("person:sam")
    expect(orgProjects({ projects: [{ id: "x", client: "globex", lead: "sam" }] })[0]).toMatchObject({ client: "globex", lead: "person:sam" })
  })

  it("reports an unknown team member or lead, and a lead that is an agent", () => {
    const agents = new Set(["pm", "dev"]), people = new Set(["sam"])
    const p = (extra: object) => orgProjects({ projects: [{ id: "a/b", name: "B", ...extra }] })
    expect(projectsProblem(p({ lead: "person:sam", team: ["dev", "person:sam"] }), agents, people)).toBeUndefined()
    expect(projectsProblem(p({ team: ["ghost"] }), agents, people)).toBe('Project B has "ghost", which is not an agent in business.orgChart in its team')
    expect(projectsProblem(p({ lead: "person:kim" }), agents, people)).toBe('Project B is led by "kim", which is not a person in people')
    expect(projectsProblem(p({ lead: "agent:pm" }), agents, people)).toMatch(/^Project B is led by "agent:pm"; a lead is a person/)
  })
})

describe("pm stays an agent id (#1687)", () => {
  const biz = (projects: any[]) => businessConfigSchema.parse({
    roles: { pm: { title: "PM" }, dev: { title: "Dev" } },
    orgChart: { pm: { role: "pm", schedule: { start: "09:00", end: "17:00" } }, dev: { role: "dev", reportsTo: "pm", schedule: { start: "09:00", end: "17:00" } } },
    projects,
  })

  it("the PM gate and the unknown-PM check behave as before, team and lead or not", () => {
    const org = new Organization(biz([{ id: "globex/site", pm: "pm", lead: "person:sam", team: ["dev", "person:kim"] }, { id: "acme/app" }]))
    expect(org.pmFor("globex/site")).toBe("pm")
    expect(org.pmFor("acme/app")).toBeUndefined()
    // A team member or a lead is never taken for the PM.
    expect(org.pmFor("person:sam")).toBeUndefined()
    expect(() => new Organization(biz([{ id: "x/y", pm: "ghost", team: ["dev"] }]))).toThrow('Project "x/y" lists unknown PM "ghost"')
  })

  it("agent → client attribution still comes from the PM, not from the team", () => {
    const map = agentClients(biz([{ id: "globex/site", pm: "pm", team: ["agent:dev"] }]) as any)
    expect(map.get("pm")).toBe("globex")
  })
})

describe("the org view's projects", () => {
  it("gives each project its lead, PM and team cards, without repeating the managers in the team", () => {
    const view = buildOrgView(config, {}, null)
    expect(view.problem).toBeUndefined()
    const [acme, globex] = view.projects
    expect(acme).toEqual({ id: "acme/app", name: "acme/app", client: "acme", pm: { key: "agent:pm", kind: "agent", id: "pm", name: "PM", status: "unknown" }, team: [] })
    expect(globex.name).toBe("Globex website")
    expect(globex.lead).toMatchObject({ key: "person:sam", kind: "person", name: "Sam Demo", title: "Owner" })
    expect(globex.pm?.key).toBe("agent:pm")
    expect(globex.team.map((c) => c.key)).toEqual(["agent:dev", "agent:ops", "person:kim"])
    // Sales is on no project.
    expect(view.notInProject.map((c) => c.key)).toEqual(["agent:sales"])
  })

  it("reports an unknown team member, leaves it out, and still builds the chart", () => {
    const bad = { ...config, business: { ...config.business, projects: [{ id: "a/b", name: "B", pm: "pm", team: ["ghost", "dev"] }] } }
    const view = buildOrgView(bad, {}, null)
    expect(view.problem).toBe('Project B has "ghost", which is not an agent in business.orgChart in its team')
    expect(view.projects[0].team.map((c) => c.key)).toEqual(["agent:dev"])
    expect(view.diagram.boxes.length).toBeGreaterThan(0)
  })

  it("with no projects, every chart member is in no project", () => {
    const none = { ...config, business: { ...config.business, projects: undefined } }
    const view = buildOrgView(none as any, {}, null)
    expect(view.projects).toEqual([])
    // People first, then agents, each by name.
    expect(view.notInProject.map((c) => c.key)).toEqual(["person:kim", "person:sam", "agent:dev", "agent:ops", "agent:pm", "agent:sales"])
  })
})

describe("the Projects view (shared by /org and the Hub)", () => {
  const html = new Function(`${ORG_PROJECTS_JS}; return orgProjectsHtml`)() as (d: any, esc: (s: string) => string) => string
  const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!))

  it("shows the client and name, the lead and PM cards, and the team grid", () => {
    const out = html(buildOrgView(config, {}, null), esc)
    const box = /<section class="opj" data-project="globex\/site"[\s\S]*?<\/section>/.exec(out)?.[0] ?? ""
    expect(box).toContain('<span class="opj-client">globex</span>')
    expect(box).toContain(">Globex website</h3>")
    expect(box).toContain('<code class="opj-id">globex/site</code>')
    expect(box).toMatch(/<ul class="opj-mgr" aria-label="Runs it"><li class="opj-card is-person" data-member="person:sam">[\s\S]*?<span class="opj-role">Lead<\/span><b class="opj-name">Sam Demo<\/b>/)
    expect(box).toMatch(/data-member="agent:pm">[\s\S]*?<span class="opj-role">PM<\/span><b class="opj-name">PM<\/b>/)
    expect(box).toContain("Team · 3</h4>")
    expect(box).toMatch(/<ul class="opj-team" aria-label="Team of Globex website">.*data-member="agent:dev".*data-member="agent:ops".*data-member="person:kim"/)
    expect(out).toMatch(/Not in a project · 1<\/h3><ul class="opj-team"><li class="opj-card is-agent" data-member="agent:sales">/)
  })

  it("shows a project with only a PM, with an empty team", () => {
    const out = html(buildOrgView(config, {}, null), esc)
    const box = /<section class="opj" data-project="acme\/app"[\s\S]*?<\/section>/.exec(out)?.[0] ?? ""
    expect(box).toContain('<span class="opj-role">PM</span>')
    expect(box).not.toContain("opj-id")
    expect(box).toContain('<h4 class="opj-sub">Team</h4><p class="opj-empty">No team yet.</p>')
  })

  it("says how to add a project when there is none, and escapes names", () => {
    expect(html({ projects: [], notInProject: [] }, esc)).toContain('<p class="opj-none">No projects yet.')
    const out = html({ projects: [{ id: "x", name: "<b>", client: "c", team: [] }], notInProject: [] }, esc)
    expect(out).toContain("&lt;b&gt;</h3>")
    expect(out).toContain("No lead or PM yet.")
  })

  it("/org has a Chart and Projects switch and a Projects section", () => {
    const page = renderOrgPage()
    expect(page).toContain('data-org-view="chart" aria-pressed="false" aria-controls="org-chart-view"')
    expect(page).toContain('data-org-view="projects" aria-pressed="false"')
    expect(page).toContain('<section id="org-projects" class="org-projects" aria-label="Projects" hidden></section>')
    expect(page).toContain("function orgProjectsHtml(d, esc)")
  })
})

describe("agentx business project (#1687)", () => {
  let dir: string
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-project-"))
    process.chdir(dir)
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({
      node: { id: "n", name: "n" },
      agents: { pm: { name: "PM", workspace: join(dir, "pm") }, dev: { name: "Dev", workspace: join(dir, "dev") } },
      people: [{ id: "sam", name: "Sam" }, { id: "kim", name: "Kim" }],
      business: { orgChart: { pm: { role: "PM", schedule }, dev: { role: "Dev", reportsTo: "pm", schedule } }, projects: [{ id: "acme/app", pm: "pm" }] },
    }))
    vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  })
  const run = (...args: string[]) => business.parseAsync(args, { from: "user" })
  const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8")).business.projects

  it("add takes --name, --lead and --team, and keeps pm as given", async () => {
    await run("project", "add", "globex/site", "--pm", "pm", "--name", "Globex website", "--lead", "sam", "--team", "dev, person:kim,dev")
    expect(saved()[1]).toEqual({ id: "globex/site", pm: "pm", name: "Globex website", lead: "person:sam", team: ["agent:dev", "person:kim"] })
    // Updating one field keeps the others; --team "" clears the team.
    await run("project", "add", "globex/site", "--team", "")
    expect(saved()[1]).toEqual({ id: "globex/site", pm: "pm", name: "Globex website", lead: "person:sam" })
  })

  it("team add and remove change one member", async () => {
    await run("project", "team", "add", "acme/app", "dev")
    await run("project", "team", "add", "acme/app", "person:kim")
    await run("project", "team", "add", "acme/app", "agent:dev")
    expect(saved()[0]).toEqual({ id: "acme/app", pm: "pm", team: ["agent:dev", "person:kim"] })
    await run("project", "team", "remove", "acme/app", "agent:dev")
    await run("project", "team", "rm", "acme/app", "person:kim")
    expect(saved()[0]).toEqual({ id: "acme/app", pm: "pm" })
  })

  async function call(body: unknown): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST" }) as unknown as IncomingMessage
    let status = 200, out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, "/api/admin/business/project", { owner: true })
    return { status, json: JSON.parse(out) }
  }

  it("the admin route upsertProject takes name, lead and team; a field left out or blank is kept", async () => {
    expect((await call({ id: "acme/app", pm: "pm", name: "Acme app", lead: "sam", team: ["dev", "person:kim"] })).status).toBe(200)
    const full = { id: "acme/app", pm: "pm", name: "Acme app", lead: "person:sam", team: ["agent:dev", "person:kim"] }
    expect(saved()[0]).toEqual(full)
    await call({ id: "acme/app", pm: "pm", client: "acme" })
    expect(saved()[0]).toEqual({ ...full, client: "acme" })
    // What the /admin form sends without Edit: blanks keep what is saved.
    await call({ id: "acme/app", pm: "pm", client: "", name: "", lead: "", team: [], clear: [] })
    expect(saved()[0]).toEqual({ ...full, client: "acme" })
    // Clear removes; a comma list works too.
    await call({ id: "acme/app", team: "dev", clear: ["name", "lead"] })
    expect(saved()[0]).toEqual({ id: "acme/app", pm: "pm", client: "acme", team: ["agent:dev"] })
    await call({ id: "acme/app", clear: ["team"] })
    expect(saved()[0]).toEqual({ id: "acme/app", pm: "pm", client: "acme" })
    await call({ id: "acme/app", team: "dev" })
    const bad = await call({ id: "acme/app", team: ["ghost"] })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    expect(bad.json.error).toContain('"ghost", which is not an agent in business.orgChart')
    expect(saved()[0].team).toEqual(["agent:dev"])
  })

  it("a team member saved earlier and since gone does not block a PM change", async () => {
    const cfg = JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
    cfg.business.projects[0].team = ["agent:gone"]
    writeFileSync(join(dir, "agentx.json"), JSON.stringify(cfg))
    expect((await call({ id: "acme/app", pm: "pm" })).status).toBe(200)
    await run("project", "team", "add", "acme/app", "dev")
    expect(saved()[0]).toEqual({ id: "acme/app", pm: "pm", team: ["agent:gone", "agent:dev"] })
  })

  it("refuses an unknown member or lead, and changes nothing", async () => {
    await expect(run("project", "team", "add", "acme/app", "ghost")).rejects.toThrow('"ghost", which is not an agent in business.orgChart')
    await expect(run("project", "add", "acme/app", "--lead", "person:nobody")).rejects.toThrow('"nobody", which is not a person in people')
    await expect(run("project", "team", "add", "nope", "dev")).rejects.toThrow('no project "nope"')
    expect(saved()).toEqual([{ id: "acme/app", pm: "pm" }])
  })
})
