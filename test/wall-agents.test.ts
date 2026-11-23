import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage, ServerResponse } from "http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { agentWorkspace, handleAdminApi } from "../src/daemon/admin-panel"
import { wallSettingsTarget, isWallWrite } from "../src/daemon/wall-actions"
import {
  agmActsHtml, agmCreateSteps, agmEditSteps, agmFormHtml, agmFormOf, agmHeadHtml, agmSlug, agmStatus, agmStatusHtml, agmTestHtml,
} from "../src/daemon/ui/pages/wall-agents"
import { LIVE, openWall } from "./wall-settings-harness"

// The Hub's Agents manager (#2144): every agent with a status, and for the
// owner one form to create an agent (name, role, workspace, model,
// channels), Edit, Pause/Resume, Test drive and Remove after a confirm.
// Every write is an existing route under the Hub's owner-only prefix.

const ENGINES: Array<[string, string]> = [["claude-code", "Claude Code"], ["codex-cli", "Codex CLI"]]
const P = "/api/admin/wall/settings"

describe("agmStatus: one status per agent", () => {
  const f = (o: Partial<Parameters<typeof agmStatus>[0]>) => agmStatus({ running: 0, needs: 0, hold: "", started: true, ...o })
  it("puts needs you first, then paused, working, not started and idle", () => {
    expect(f({ hold: "waiting", running: 2 }).key).toBe("needs")
    expect(f({ needs: 1, hold: "paused", running: 1 })).toMatchObject({ key: "needs", label: "Needs you", title: "1 item waits on you" })
    expect(f({ hold: "paused", running: 1 }).key).toBe("paused")
    expect(f({ running: 2 })).toMatchObject({ key: "working", label: "Working", title: "2 tasks running now" })
    expect(f({ started: false })).toMatchObject({ key: "off", label: "Not started" })
    expect(f({})).toMatchObject({ key: "idle", label: "Idle" })
  })
  it("draws it as a chip", () => {
    expect(agmStatusHtml(f({ running: 1 }))).toBe('<span class="chip agm-st is-working" title="1 task running now">Working</span>')
  })
})

describe("agmCreateSteps: one form, the existing routes in order", () => {
  it("makes an id from the name, wakes it on @id, and creates the agent only", () => {
    expect(agmSlug("Sales Désk!")).toBe("sales-desk")
    expect(agmCreateSteps({ name: "Sales Désk" })).toEqual({
      id: "sales-desk", error: "",
      steps: [{ method: "POST", path: P + "/agents", body: { id: "sales-desk", name: "Sales Désk", triggerWords: "@sales-desk", tier: "claude-code" }, what: "the agent" }],
    })
  })
  it("carries role, workspace, model and instructions, then public API and each channel", () => {
    const plan = agmCreateSteps({
      name: "Sales", id: "sales", role: "Sales lead", workspace: "~/work/sales", tier: "codex-cli", model: "gpt-5", triggers: "@sales, sales",
      instructions: "Answer pricing.", publicApi: true, telegramEnv: "SALES_TG", slackBotEnv: "SLACK_BOT", slackAppEnv: "SLACK_APP", discordEnv: "DISCORD_TOKEN",
    })
    expect(plan.error).toBe("")
    expect(plan.steps.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST ${P}/agents`, `POST ${P}/agents/access`, `POST ${P}/channels/telegram`, `POST ${P}/channels/slack`, `POST ${P}/channels/discord`,
    ])
    expect(plan.steps[0].body).toEqual({ id: "sales", name: "Sales", triggerWords: "@sales, sales", tier: "codex-cli", model: "gpt-5", personality: "Answer pricing.", role: "Sales lead", workspace: "~/work/sales" })
    expect(plan.steps[2].body).toEqual({ id: "sales", agentBinding: "sales", botTokenEnv: "SALES_TG" })
    expect(plan.steps[3].body).toEqual({ botTokenEnv: "SLACK_BOT", appTokenEnv: "SLACK_APP", agentBinding: "sales" })
    expect(plan.steps[4].body).toEqual({ tokenEnv: "DISCORD_TOKEN", agentBinding: "sales" })
    // Every write is under the Hub's owner guard, and served by the classic route.
    for (const s of plan.steps) {
      expect(isWallWrite(s.method, s.path)).toBe(true)
      expect(wallSettingsTarget(s.method, s.path)).toBe(s.path.replace("/wall/settings", ""))
    }
  })
  it("refuses a missing name, a bad id, a token value instead of its name, and half a Slack", () => {
    expect(agmCreateSteps({}).error).toBe("Give the agent a name.")
    expect(agmCreateSteps({ name: "X", id: "Bad Id" }).error).toMatch(/lowercase/)
    expect(agmCreateSteps({ name: "X", telegramEnv: "123:abc" }).error).toMatch(/^Telegram token: write the environment variable's name/)
    expect(agmCreateSteps({ name: "X", slackBotEnv: "SLACK_BOT" }).error).toMatch(/both token names/)
  })
})

describe("agmEditSteps: only what changed", () => {
  const A = { id: "cx", name: "Customer Desk", tier: "claude-code", model: "model-a", mentions: ["@cx", "cx"], access: "private", systemPrompt: "Hi.", workspace: "/w/cx" }
  it("patches the changed fields, sets the role and the access", () => {
    const f = { ...agmFormOf(A, "Support lead"), name: "Desk", model: "", role: "Head of support", publicApi: true }
    expect(agmEditSteps(A, "Support lead", true, f)).toEqual({ id: "cx", error: "", steps: [
      { method: "PATCH", path: P + "/agents", body: { id: "cx", patch: { name: "Desk", model: "" } }, what: "its settings" },
      { method: "POST", path: P + "/org/chart", body: { op: "set-role", member: "agent:cx", role: "Head of support" }, what: "its role" },
      { method: "POST", path: P + "/agents/access", body: { id: "cx", access: "public" }, what: "public API access" },
    ] })
    // Not in the chart yet: the role adds it.
    expect(agmEditSteps(A, "", false, { ...agmFormOf(A, ""), role: "Desk" }).steps[0].body).toEqual({ op: "add-member", member: "agent:cx", role: "Desk" })
  })
  it("says when nothing changed, and keeps a wake word and a chart role", () => {
    expect(agmEditSteps(A, "", false, agmFormOf(A, "")).error).toBe("Nothing changed.")
    expect(agmEditSteps(A, "", false, { ...agmFormOf(A, ""), triggers: " " }).error).toMatch(/wake word/)
    expect(agmEditSteps(A, "Lead", true, { ...agmFormOf(A, "Lead"), role: "" }).error).toMatch(/keeps a role/)
  })
})

describe("the manager's markup escapes fleet text", () => {
  const evil = '<img src=x onerror="alert(1)">'
  it("in the form, the buttons, the test drive and the head", () => {
    const form = agmFormHtml({ name: evil, role: evil, workspace: evil, instructions: evil, tier: "codex-cli" }, "new", ENGINES, evil)
    expect(form).not.toContain("<img")
    expect(form).toContain('value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"')
    expect(form).toContain('<option value="codex-cli" selected>')
    for (const id of ["agm-f-name", "agm-f-id", "agm-f-role", "agm-f-workspace", "agm-f-tier", "agm-f-model", "agm-f-telegramEnv", "agm-f-slackBotEnv", "agm-f-discordEnv"]) expect(form).toContain(`id="${id}"`)
    const edit = agmFormHtml({ id: "cx", name: "Desk", workspace: "/w/<cx>" }, "edit", ENGINES, "")
    expect(edit).toContain('data-agm-form="edit" data-id="cx"')
    expect(edit).not.toContain('id="agm-f-workspace"')
    expect(edit).toContain("<code>/w/&lt;cx&gt;</code>")
    const acts = agmActsHtml("cx", evil, agmStatus({ running: 0, needs: 0, hold: "", started: true }), "", "cx")
    expect(acts).not.toContain("<img")
    expect(acts).toContain('data-agm-act="pause" data-id="cx"')
    expect(acts).toContain('data-agm-act="remove" data-id="cx"')
    expect(agmActsHtml("cx", "D", agmStatus({ running: 0, needs: 0, hold: "paused", started: true }), "paused", "")).toContain('data-agm-act="resume"')
    expect(agmActsHtml("cx", "D", agmStatus({ running: 0, needs: 0, hold: "waiting", started: true }), "waiting", "")).toContain("Approve in Needs you")
    expect(agmTestHtml("cx", evil, { agent: "cx", msgs: [{ kind: "agent", text: evil }] })).not.toContain("<img")
    expect(agmHeadHtml(false, "x", "needed", "")).toBe("")
    expect(agmHeadHtml(true, evil, "needed", "")).not.toContain("<img")
    expect(agmHeadHtml(true, "", "needed", "")).toContain('data-agm-act="restart"')
  })
})

describe("POST /api/admin/agents: workspace and role from the Hub form", () => {
  let dir: string
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agentx-hub-agents-")))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({ agents: { lead: { name: "Lead", workspace: join(dir, "agents", "lead"), mentions: ["@lead"] } } }))
    process.chdir(dir)
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })
  async function call(body: unknown, owner?: boolean): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST" }) as unknown as IncomingMessage
    let status = 200, out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, "/api/admin/agents", owner === undefined ? undefined : { owner })
    return { status, json: JSON.parse(out) }
  }
  const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))

  it("resolves the workspace: default, relative, home, and refuses a bad one", () => {
    expect(agentWorkspace("", "ops")).toEqual({ path: join(process.cwd(), "agents", "ops"), custom: false })
    expect(agentWorkspace("work/ops", "ops").path).toBe(join(process.cwd(), "work", "ops"))
    expect(agentWorkspace("~/ops", "ops", "/home/me")).toEqual({ path: "/home/me/ops", custom: true })
    expect(() => agentWorkspace("a\nb", "ops")).toThrow("one line")
    expect(() => agentWorkspace("~/x", "ops", "")).toThrow("full path")
  })

  it("saves the workspace the owner picked, with its role in the chart and no line", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      const r = await call({ id: "ops", name: "Ops", triggerWords: "@ops", workspace: "work/ops", role: "Night shift" }, true)
      expect(r.status).toBe(200)
      expect(r.json.summary).toMatch(/^added agent "ops": /)
      const cfg = saved()
      expect(cfg.agents.ops.workspace).toBe(join(dir, "work", "ops"))
      expect(cfg.business.orgChart.ops).toMatchObject({ role: "night-shift" })
      expect(cfg.business.orgChart.ops.reportsTo).toBeUndefined()
      // A new folder gets its CLAUDE.md.
      expect(existsSync(join(dir, "work", "ops", "CLAUDE.md"))).toBe(true)
    } finally { fetchMock.mockRestore() }
  })

  it("writes nothing in a folder of the owner's that exists already", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      mkdirSync(join(dir, "repo"))
      expect((await call({ id: "dev", name: "Dev", triggerWords: "@dev", workspace: "repo" }, true)).status).toBe(200)
      expect(saved().agents.dev.workspace).toBe(join(dir, "repo"))
      expect(existsSync(join(dir, "repo", "CLAUDE.md"))).toBe(false)
    } finally { fetchMock.mockRestore() }
  })

  it("keeps the role (an org chart change) the owner's, and writes nothing otherwise", async () => {
    const r = await call({ id: "ops", name: "Ops", triggerWords: "@ops", role: "Night shift" }, false)
    expect(r).toMatchObject({ status: 403, json: { error: "Only the owner can change the org chart." } })
    expect(saved().agents.ops).toBeUndefined()
  })
})

describe("the Hub's Agents page (#2144)", () => {
  // The harness's org: cx idle, ops paused, new waits for approval; the
  // live list reports cx and ops. A Needs you card from cx.
  const route = (cards: unknown[] = []) => (u: string) =>
    u.startsWith("/api/admin/approvals?") ? { status: 200, body: { items: cards, settings: {} } } : undefined
  const page = (w: ReturnType<typeof openWall>) => w.el("wall-agents-page")!.innerHTML as string
  const card = (w: ReturnType<typeof openWall>, id: string) => page(w).split(`id="agent-${id}"`)[1]?.split("</article>")[0] ?? ""

  it("shows each agent's status, and a saved agent no machine runs yet", async () => {
    const w = openWall({ hash: "#page=agents", route: route([{ key: "card:1", kind: "card", title: "Refund?", raised_by: "cx", created_at: new Date().toISOString() }]) })
    await w.settle()
    expect(card(w, "cx")).toContain('agm-st is-needs')
    expect(card(w, "ops")).toContain('agm-st is-paused')
    expect(card(w, "new")).toContain('agm-st is-needs') // waits for approval
    expect(card(w, "ops")).toContain('data-agm-act="resume" data-id="ops"')
    expect(page(w)).toContain('data-agm-act="new"')
  })

  it("for anyone but the owner: statuses, no buttons, no settings read, no write", async () => {
    const w = openWall({ hash: "#page=agents", owner: false })
    await w.settle()
    expect(card(w, "cx")).toContain("agm-st is-idle")
    expect(page(w)).not.toContain("data-agm-act")
    expect(page(w)).not.toContain('id="agent-new"')
    expect(w.calls.some((c) => c.url === "/api/admin/state")).toBe(false)
    expect(w.writes()).toEqual([])
  })

  it("creates an agent from one form, asks for the restart, then test drives it", async () => {
    const w = openWall({ hash: "#page=agents", route: (u, i) => u === P + "/agents/test" && i.method === "POST" ? { status: 200, body: { chatId: "c", response: { content: "Hello, I am Sales." } } } : undefined })
    await w.settle()
    await w.click({ "data-agm-act": "new" })
    expect(page(w)).toContain('data-agm-form="new"')
    await w.type("agm-f-name", "Sales")
    await w.type("agm-f-role", "Sales lead")
    await w.type("agm-f-workspace", "~/work/sales")
    await w.type("agm-f-model", "model-b")
    await w.type("agm-f-telegramEnv", "SALES_TG")
    await w.submit({ "data-agm-form": "new" })
    expect(w.writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", P + "/agents", { id: "sales", name: "Sales", triggerWords: "@sales", tier: "claude-code", model: "model-b", role: "Sales lead", workspace: "~/work/sales" }],
      ["POST", P + "/channels/telegram", { id: "sales", agentBinding: "sales", botTokenEnv: "SALES_TG" }],
    ])
    expect(page(w)).toContain("Created @sales.")
    await w.click({ "data-agm-act": "restart" })
    expect(w.writes().at(-1)).toMatchObject({ method: "POST", url: "/api/admin/wall/live/restart?node=" + encodeURIComponent(LIVE.nodes[0].url) })
    expect(page(w)).toContain("Restart asked")
    // The test drive opened for it; it is only drawn on a card the settings list.
    await w.click({ "data-agm-act": "test", "data-id": "cx" })
    w.el("agm-td-text").value = "hi"
    await w.click({ "data-agm-act": "send", "data-id": "cx" })
    expect(w.writes().at(-1)).toMatchObject({ method: "POST", url: P + "/agents/test", body: { agent: "cx", message: "hi" } })
    expect(w.el("agm-td-log").innerHTML).toContain("Hello, I am Sales.")
  })

  it("says what a refused create step was, and keeps the form", async () => {
    const w = openWall({ hash: "#page=agents", route: (u, i) => u === P + "/agents" && i.method === "POST" ? { status: 400, body: { error: 'Agent "cx" already exists.' } } : undefined })
    await w.settle()
    await w.click({ "data-agm-act": "new" })
    await w.type("agm-f-name", "cx")
    await w.submit({ "data-agm-form": "new" })
    expect(w.el("agm-n-form").textContent).toBe('Not saved the agent: Agent "cx" already exists.')
    expect(page(w)).toContain('data-agm-form="new"')
  })

  it("edits, pauses, resumes and removes (after a confirm)", async () => {
    const w = openWall({ hash: "#page=agents" })
    await w.settle()
    await w.click({ "data-agm-act": "edit", "data-id": "cx" })
    expect(card(w, "cx")).toContain('data-agm-form="edit" data-id="cx"')
    await w.type("agm-f-model", "model-c")
    await w.submit({ "data-agm-form": "edit", "data-id": "cx" })
    expect(w.writes().at(-1)).toEqual({ method: "PATCH", url: P + "/agents", body: { id: "cx", patch: { model: "model-c" } } })
    await w.click({ "data-agm-act": "pause", "data-id": "cx" })
    expect(w.writes().at(-1)).toEqual({ method: "POST", url: P + "/org/hold", body: { agent: "cx", paused: true } })
    await w.click({ "data-agm-act": "resume", "data-id": "ops" })
    expect(w.writes().at(-1)).toEqual({ method: "POST", url: P + "/org/hold", body: { agent: "ops", paused: false } })
    const before = w.writes().length
    await w.click({ "data-agm-act": "ask", "data-id": "ops" })
    expect(w.writes().length).toBe(before)
    expect(card(w, "ops")).toContain("Remove @ops (Night Shift)?")
    await w.click({ "data-agm-act": "remove", "data-id": "ops" })
    expect(w.writes().at(-1)).toEqual({ method: "DELETE", url: P + "/agents", body: { id: "ops" } })
    expect(page(w)).toContain('data-agm-act="restart"')
  })
})
