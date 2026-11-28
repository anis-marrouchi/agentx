import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { IncomingMessage, ServerResponse } from "http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Readable } from "stream"
import { agentWorkspace, handleAdminApi, setRunningOfForTest, workspaceProblem } from "../src/daemon/admin-panel"
import { chmodSync } from "fs"
import { wallSettingsTarget, isWallWrite } from "../src/daemon/wall-actions"
import {
  agmActsHtml, agmCreateSteps, agmEditSteps, agmFormHtml, agmFormOf, agmHeadHtml, agmRemoveHtml, agmSlug, agmStatus, agmStatusHtml, agmTestHtml,
} from "../src/daemon/ui/pages/wall-agents"
import { LIVE, STATE, openWall } from "./wall-settings-harness"

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
    expect(agmStatusHtml(f({ running: 1 }))).toBe('<span class="ax-af-state agm-st is-working" data-state="running" title="1 task running now">Working</span>')
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
    expect(agmCreateSteps({ name: "X", telegramEnv: "123:abc" }).error).toMatch(/^Telegram bot token: write the environment variable's name/)
    // Every field's problem, for the error under each field (#2144).
    expect(agmCreateSteps({ id: "Bad Id", telegramEnv: "123:abc" }).errors).toMatchObject({ name: "Give the agent a name.", id: expect.stringMatching(/lowercase/), telegramEnv: expect.stringMatching(/capitals/) })
    expect(agmCreateSteps({ name: "X", slackBotEnv: "SLACK_BOT" }).error).toMatch(/both token names/)
    expect(agmCreateSteps({ name: "X", instructions: "a".repeat(4001) }).error).toMatch(/up to 4000 characters/)
    expect(agmCreateSteps({ name: "X", instructions: "a".repeat(4000) }).error).toBe("")
  })
  it("asks before taking this machine's one Slack or Discord bot from another agent", () => {
    const f = { name: "Sales", slackBotEnv: "SLACK_BOT", slackAppEnv: "SLACK_APP", discordEnv: "DISCORD_TOKEN" }
    const bound = { slack: "cx", discord: "ops" }
    // Both asked at once, each under its own field; the note says the first in form order (Discord, then Slack).
    expect(agmCreateSteps(f, bound).errors).toMatchObject({ moveSlack: 'Slack\'s bot answers as @cx now. Tick "Move the Slack bot" to make it answer as @sales, or leave the Slack fields empty.' })
    expect(agmCreateSteps({ ...f, moveDiscord: true }, bound).error).toMatch(/^Slack's bot answers as @cx now/)
    expect(agmCreateSteps({ ...f, moveSlack: true }, bound).error).toMatch(/^Discord's bot answers as @ops now/)
    const plan = agmCreateSteps({ ...f, moveSlack: true, moveDiscord: true }, bound)
    expect(plan.steps[1].body).toEqual({ botTokenEnv: "SLACK_BOT", appTokenEnv: "SLACK_APP", agentBinding: "sales", moveBot: true })
    expect(plan.steps[2].body).toEqual({ tokenEnv: "DISCORD_TOKEN", agentBinding: "sales", moveBot: true })
    // A bot bound to no agent, or to this one, needs no yes and sends none.
    const free = agmCreateSteps(f, { slack: "", discord: "sales" })
    expect(free.error).toBe("")
    expect(free.steps.every((s) => !("moveBot" in s.body))).toBe(true)
    // The form says whom each bot answers as, and offers the move.
    const html = agmFormHtml({ name: "Sales" }, "new", ENGINES, { bound: { slack: "cx", discord: "" } })
    expect(html).toContain("It answers as <b>@cx</b> now.")
    expect(html).toContain('id="agm-f-moveSlack"')
    expect(html).not.toContain('id="agm-f-moveDiscord"')
    expect(html).toContain("Discord bot. It answers as no agent now.")
    expect(html).toContain('maxlength="4000"')
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
    expect(agmEditSteps(A, "", false, { ...agmFormOf(A, ""), instructions: "a".repeat(4001) }).error).toMatch(/up to 4000 characters/)
  })
})

describe("the manager's markup escapes fleet text", () => {
  const evil = '<img src=x onerror="alert(1)">'
  it("in the form, the buttons, the test drive and the head", () => {
    const form = agmFormHtml({ name: evil, role: evil, workspace: evil, instructions: evil, tier: "codex-cli" }, "new", ENGINES, { note: evil, errors: { name: evil }, base: "/d", home: "/h" })
    expect(form).not.toContain("<img")
    expect(form).toContain('value="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"')
    expect(form).toContain('<option value="codex-cli" selected>')
    for (const id of ["agm-f-name", "agm-f-id", "agm-f-role", "agm-f-workspace", "agm-f-tier", "agm-f-model", "agm-f-telegramEnv", "agm-f-slackBotEnv", "agm-f-discordEnv"]) expect(form).toContain(`id="${id}"`)
    const edit = agmFormHtml({ id: "cx", name: "Desk", workspace: "/w/<cx>" }, "edit", ENGINES, {})
    expect(edit).toContain('data-agm-form="edit" data-id="cx"')
    expect(edit).not.toContain('id="agm-f-workspace"')
    expect(edit).toContain('<code class="agm-path">/w/&lt;cx&gt;</code>')
    expect(agmFormHtml({ id: "a&b", name: "D" }, "edit", ENGINES, {})).toContain("agent=a%26b\"")
    const acts = agmActsHtml("cx", evil, agmStatus({ running: 0, needs: 0, hold: "", started: true }), "", "cx")
    expect(acts).not.toContain("<img")
    expect(acts).toContain('data-agm-act="pause" data-id="cx"')
    // Test drive and Remove sit in the open "…" menu, Remove last after a line.
    expect(acts).toMatch(/data-agm-act="test" data-id="cx".*<hr>.*class="is-danger" data-agm-act="ask" data-id="cx"/s)
    expect(agmActsHtml("cx", "D", agmStatus({ running: 0, needs: 0, hold: "", started: true }), "", "")).not.toContain('data-agm-act="ask"')
    const rm = agmRemoveHtml({ id: "cx", name: evil, workspace: "/w/<cx>", running: 0 })
    expect(rm).not.toContain("<img")
    expect(rm).toContain('role="alertdialog"')
    expect(rm).toContain('data-agm-act="remove" data-id="cx"')
    expect(rm).toContain("<code>/w/&lt;cx&gt;</code>")
    const busy = agmRemoveHtml({ id: "cx", name: "D", workspace: "", running: 2 })
    expect(busy).toContain("@cx has 2 tasks running.")
    expect(busy).toMatch(/id="agm-rm-go" data-agm-act="remove-idle"/)
    expect(busy).toContain('data-agm-act="remove-now"')
    expect(agmActsHtml("cx", "D", agmStatus({ running: 0, needs: 0, hold: "paused", started: true }), "paused", "")).toContain('data-agm-act="resume"')
    expect(agmActsHtml("cx", "D", agmStatus({ running: 0, needs: 0, hold: "waiting", started: true }), "waiting", "")).toContain("Approve in Waiting on you")
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
  async function call(body: unknown, owner?: boolean, method = "POST", path = "/api/admin/agents"): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method }) as unknown as IncomingMessage
    let status = 200, out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, path, owner === undefined ? undefined : { owner })
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

  it("keeps a picked workspace the owner's: refused for anyone else, with nothing written", async () => {
    const before = readFileSync(join(dir, "agentx.json"), "utf-8")
    for (const owner of [false, undefined]) {
      const r = await call({ id: "ops", name: "Ops", triggerWords: "@ops", workspace: "/etc" }, owner)
      expect(r).toMatchObject({ status: 403, json: { error: "Only the owner can pick an agent's workspace." } })
    }
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).toBe(before)
    expect(existsSync(join(dir, "agents", "ops"))).toBe(false)
    // Blank is the default folder, not a pick; the owner's pick is saved.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
    try {
      expect((await call({ id: "ops", name: "Ops", triggerWords: "@ops", workspace: "  " }, false)).status).toBe(200)
      expect(saved().agents.ops.workspace).toBe(join(dir, "agents", "ops"))
      expect((await call({ id: "sec", name: "Sec", triggerWords: "@sec", workspace: "work/sec" }, true)).status).toBe(200)
      expect(saved().agents.sec.workspace).toBe(join(dir, "work", "sec"))
    } finally { fetchMock.mockRestore() }
  })
})

describe("DELETE /api/admin/agents and the bots: Remove leaves nothing behind (#2144)", () => {
  let dir: string
  const prevCwd = process.cwd()
  let fetchMock: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "agentx-hub-agents-rm-")))
    writeFileSync(join(dir, "agentx.json"), JSON.stringify({
      agents: { lead: { name: "Lead", workspace: join(dir, "agents", "lead"), mentions: ["@lead"] } },
      channels: {
        telegram: { enabled: true, accounts: { sales: { agentBinding: "lead", botToken: "${TG}" } } },
        slack: { enabled: true, botToken: "${SLACK_BOT}", appToken: "${SLACK_APP}", agentBinding: "lead" },
        discord: { enabled: true, token: "${DISCORD}", agentBinding: "lead" },
      },
    }))
    process.chdir(dir)
    fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"))
  })
  afterEach(() => { fetchMock.mockRestore(); process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })
  const saved = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))
  async function call(body: unknown, method = "POST", path = "/api/admin/agents", owner = true): Promise<{ status: number; json: any }> {
    const req = Object.assign(Readable.from([JSON.stringify(body)]), { method }) as unknown as IncomingMessage
    let status = 200, out = ""
    const res = { writeHead: (s: number) => { status = s; return res }, end: (b: string) => { out = b } } as unknown as ServerResponse
    await handleAdminApi(req, res, path, { owner })
    return { status, json: JSON.parse(out) }
  }

  it("refuses a busy agent with 409 and its running count, and removes it with force (#2144)", async () => {
    expect((await call({ id: "sales", name: "Sales", triggerWords: "@sales" })).status).toBe(200)
    setRunningOfForTest(async () => ({ sales: 2, lead: 1 }))
    try {
      expect(await call({ id: "sales" }, "DELETE")).toEqual({ status: 409, json: { running: 2, error: "@sales has 2 tasks running." } })
      expect(saved().agents.sales).toBeTruthy()
      expect((await call({ id: "sales", force: true }, "DELETE")).status).toBe(200)
      expect(saved().agents.sales).toBeUndefined()
    } finally { setRunningOfForTest(null) }
    // The daemon not answering means nothing of it runs: removed.
    expect((await call({ id: "lead" }, "DELETE")).status).toBe(200)
  })

  it("never deletes the workspace folder or its files (#2144 C4)", async () => {
    expect((await call({ id: "sales", name: "Sales", triggerWords: "@sales" })).status).toBe(200)
    const ws = saved().agents.sales.workspace
    writeFileSync(join(ws, "notes.md"), "keep me")
    expect((await call({ id: "sales" }, "DELETE")).status).toBe(200)
    expect(readFileSync(join(ws, "notes.md"), "utf-8")).toBe("keep me")
    expect(existsSync(join(ws, "CLAUDE.md"))).toBe(true)
    // Created again with the same folder, it finds its files there.
    expect((await call({ id: "sales", name: "Sales", triggerWords: "@sales", workspace: ws })).status).toBe(200)
    expect(readFileSync(join(ws, "notes.md"), "utf-8")).toBe("keep me")
  })

  it("refuses a workspace that is a file or cannot be written, and saves nothing (#2144 C1)", async () => {
    const before = readFileSync(join(dir, "agentx.json"), "utf-8")
    writeFileSync(join(dir, "afile"), "x")
    const file = await call({ id: "w1", name: "W", triggerWords: "@w1", workspace: "afile" })
    expect(file).toEqual({ status: 400, json: { field: "workspace", error: `The workspace is a file, not a folder: ${join(dir, "afile")}.` } })
    const under = await call({ id: "w2", name: "W", triggerWords: "@w2", workspace: "afile/sub" })
    expect(under.json).toEqual({ field: "workspace", error: `The workspace cannot be made: ${join(dir, "afile")} is a file.` })
    expect(workspaceProblem(join(dir, "new", "deep"))).toBe("")
    if (process.getuid?.() !== 0) {
      mkdirSync(join(dir, "locked"))
      chmodSync(join(dir, "locked"), 0o555)
      try {
        const locked = await call({ id: "w3", name: "W", triggerWords: "@w3", workspace: "locked/ws" })
        expect(locked.json).toEqual({ field: "workspace", error: `The workspace cannot be made: AgentX cannot write in ${join(dir, "locked")}.` })
        expect(existsSync(join(dir, "locked", "ws"))).toBe(false)
      } finally { chmodSync(join(dir, "locked"), 0o755) }
    }
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).toBe(before)
    // A refused save (the id is taken) leaves no empty folder behind.
    expect((await call({ id: "lead", name: "Lead 2", triggerWords: "@lead", workspace: "fresh" })).status).toBe(400)
    expect(existsSync(join(dir, "fresh"))).toBe(false)
  })

  it("takes the agent out of the org chart with its lines, so the same id is created again with a role", async () => {
    expect((await call({ id: "sales", name: "Sales", triggerWords: "@sales", role: "Sales lead" })).status).toBe(200)
    expect((await call({ op: "add-member", member: "agent:lead", role: "Boss" }, "POST", "/api/admin/org/chart")).status).toBe(200)
    expect((await call({ op: "add-relation", from: "agent:sales", type: "reports-to", to: "agent:lead" }, "POST", "/api/admin/org/chart")).status).toBe(200)
    expect(saved().business.orgChart.sales).toBeTruthy()
    const r = await call({ id: "sales" }, "DELETE")
    expect(r.status).toBe(200)
    expect(r.json.summary).toMatch(/^removed agent "sales"; .*removed from the org chart, with 1 line/)
    const cfg = saved()
    expect(cfg.agents.sales).toBeUndefined()
    expect(cfg.business.orgChart.sales).toBeUndefined()
    expect(JSON.stringify(cfg.business)).not.toContain("agent:sales")
    // The round trip the review found: create, Remove, create again with a role.
    const again = await call({ id: "sales", name: "Sales", triggerWords: "@sales", role: "Sales lead" })
    expect(again.status).toBe(200)
    expect(saved().business.orgChart.sales).toMatchObject({ role: "sales-lead" })
  })

  it("refuses to remove a project's manager, with org-edit's sentence, and changes nothing", async () => {
    expect((await call({ id: "pm", name: "PM", triggerWords: "@pm", role: "Manager" })).status).toBe(200)
    const cfg = saved()
    cfg.business.projects = [{ id: "site", name: "Site", pm: "pm" }]
    writeFileSync(join(dir, "agentx.json"), JSON.stringify(cfg))
    const before = readFileSync(join(dir, "agentx.json"), "utf-8")
    const r = await call({ id: "pm" }, "DELETE")
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/is the project manager of "site"\. Give that project another manager first\./)
    expect(readFileSync(join(dir, "agentx.json"), "utf-8")).toBe(before)
  })

  it("unbinds the Telegram, Slack and Discord bots that answered as it", async () => {
    expect((await call({ id: "lead" }, "DELETE")).status).toBe(200)
    const ch = saved().channels
    expect(ch.telegram.accounts.sales.agentBinding).toBe("")
    expect(ch.slack.agentBinding).toBe("")
    expect(ch.discord.agentBinding).toBe("")
    // The tokens stay: the bot is free for the next agent.
    expect(ch.slack.botToken).toBe("${SLACK_BOT}")
  })

  it("refuses to move the Slack or Discord bot from another agent without moveBot", async () => {
    expect((await call({ id: "sales", name: "Sales", triggerWords: "@sales" })).status).toBe(200)
    const slack = { botTokenEnv: "NEW_BOT", appTokenEnv: "NEW_APP", agentBinding: "sales" }
    const r = await call(slack, "POST", "/api/admin/channels/slack")
    expect(r).toMatchObject({ status: 409, json: { error: "Slack's bot answers as @lead now. Confirm to move it to @sales: @lead then stops answering on Slack." } })
    const d = await call({ tokenEnv: "NEW_DC", agentBinding: "sales" }, "POST", "/api/admin/channels/discord")
    expect(d.status).toBe(409)
    expect(d.json.error).toMatch(/^Discord's bot answers as @lead now/)
    // Nothing was written: not the binding, not the token names.
    expect(saved().channels.slack).toMatchObject({ agentBinding: "lead", botToken: "${SLACK_BOT}" })
    expect(saved().channels.discord).toMatchObject({ agentBinding: "lead", token: "${DISCORD}" })
    // The same binding, no binding, or a yes go through.
    expect((await call({ ...slack, agentBinding: "lead" }, "POST", "/api/admin/channels/slack")).status).toBe(200)
    expect((await call({ ...slack, moveBot: true }, "POST", "/api/admin/channels/slack")).status).toBe(200)
    expect(saved().channels.slack).toMatchObject({ agentBinding: "sales", botToken: "${NEW_BOT}" })
    expect((await call({ tokenEnv: "NEW_DC", agentBinding: "sales", moveBot: true }, "POST", "/api/admin/channels/discord")).status).toBe(200)
    expect(saved().channels.discord.agentBinding).toBe("sales")
  })

  it("keeps the same instructions limit on create and edit, and does not cut them", async () => {
    const long = "a".repeat(4001)
    expect((await call({ id: "w", name: "W", triggerWords: "@w", personality: long })).json.error).toMatch(/up to 4000 characters/)
    expect(saved().agents.w).toBeUndefined()
    const ok = "b".repeat(1200)
    expect((await call({ id: "w", name: "W", triggerWords: "@w", personality: ok })).status).toBe(200)
    expect(saved().agents.w.systemPrompt).toBe(ok)
    expect((await call({ id: "w", patch: { systemPrompt: long } }, "PATCH")).json.error).toMatch(/up to 4000 characters/)
    expect((await call({ id: "w", patch: { systemPrompt: "c".repeat(4000) } }, "PATCH")).status).toBe(200)
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
    // @sales shows in the live list once the restart is done, and in the saved settings after the create.
    let started = false, created = false
    const withSales = { nodes: [{ ...LIVE.nodes[0], agents: [...LIVE.nodes[0].agents, { id: "sales", name: "Sales", runningTasks: [] }] }] }
    const w = openWall({ hash: "#page=agents", route: (u, i) =>
      u === P + "/agents/test" && i.method === "POST" ? { status: 200, body: { chatId: "c", response: { content: "Hello, I am Sales." } } }
      : u === P + "/agents" && i.method === "POST" ? (created = true, { status: 200, body: { summary: "ok" } })
      : u.startsWith("/api/live?") && started ? { status: 200, body: withSales }
      : u === "/api/admin/state" && created ? { status: 200, body: { ...STATE, agents: [...(STATE as any).agents, { id: "sales", name: "Sales", tier: "claude-code", mentions: ["@sales"], workspace: "/w/sales" }] } }
      : undefined })
    await w.settle()
    await w.click({ "data-agm-act": "new" })
    expect(page(w)).toContain('data-agm-form="new"')
    await w.type("agm-f-name", "Sales")
    await w.type("agm-f-role", "Sales lead")
    await w.type("agm-f-workspace", "~/work/sales")
    await w.type("agm-f-model", "model-b")
    await w.type("agm-f-telegramEnv", "SALES_TG")
    // Enter in a field: focus stays in the Sheet, and the page still closes it.
    w.doc.activeElement = { id: "agm-f-telegramEnv" } as any
    await w.submit({ "data-agm-form": "new" })
    expect(page(w)).not.toContain('data-agm-form="new"')
    expect(w.writes().map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", P + "/agents", { id: "sales", name: "Sales", triggerWords: "@sales", tier: "claude-code", model: "model-b", role: "Sales lead", workspace: "~/work/sales" }],
      ["POST", P + "/channels/telegram", { id: "sales", agentBinding: "sales", botTokenEnv: "SALES_TG" }],
    ])
    expect(page(w)).toContain("Created @sales.")
    await w.click({ "data-agm-act": "restart" })
    expect(w.writes().at(-1)).toMatchObject({ method: "POST", url: "/api/admin/wall/live/restart?node=" + encodeURIComponent(LIVE.nodes[0].url) })
    expect(page(w)).toContain("Restart asked")
    expect(page(w)).toContain("Waiting for @sales to start")
    // Proof path: once /api/live reports @sales, its Test drive opens with a first message ready.
    started = true
    await w.click({ "data-agm-act": "restart" })
    expect(page(w)).toContain("@sales started. Send the message below to test it.")
    expect(page(w)).toContain('id="agm-td-text"')
    expect(page(w)).toContain(">Say hello in one line.</textarea>")
    // Test drive from the "…" menu on another card.
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

  it("keeps the form and its values when a later step fails, and does not send the saved steps again", async () => {
    let telegramFails = true
    const w = openWall({ hash: "#page=agents", route: (u, i) =>
      u === "/api/admin/state" ? { status: 200, body: { ...STATE, slack: { agentBinding: "cx" }, discord: { agentBinding: "" } } }
      : u === P + "/channels/telegram" && i.method === "POST" && telegramFails ? { status: 400, body: { error: "Account id is taken." } } : undefined })
    await w.settle()
    await w.click({ "data-agm-act": "new" })
    expect(page(w)).toContain("It answers as <b>@cx</b> now.")
    await w.type("agm-f-name", "Sales")
    await w.type("agm-f-telegramEnv", "SALES_TG")
    await w.type("agm-f-slackBotEnv", "SLACK_BOT")
    await w.type("agm-f-slackAppEnv", "SLACK_APP")
    await w.submit({ "data-agm-form": "new" })
    // The Slack bot answers as @cx: nothing is sent until the owner says yes.
    expect(w.writes()).toEqual([])
    // The sentence shows under the tick box; the note under the buttons counts the fields.
    expect(w.el("agm-n-form").textContent).toBe("Not saved: fix the field in red.")
    expect(page(w)).toContain('<p class="agm-err" id="agm-e-moveSlack">Slack&#39;s bot answers as @cx now.')
    await w.type("agm-f-moveSlack", true)
    await w.submit({ "data-agm-form": "new" })
    expect(w.writes().map((c) => c.url)).toEqual([P + "/agents", P + "/channels/telegram"])
    // The note says it in the Sheet that stays open; the Hub's refresh does not repaint over the Sheet.
    expect(w.el("agm-n-form").textContent).toBe("Saved the agent; not Telegram: Account id is taken. Fix it and press Create agent again: what is saved is not sent again.")
    expect(page(w)).toContain('data-agm-form="new"')
    expect(page(w)).toContain('value="SALES_TG"')
    telegramFails = false
    await w.submit({ "data-agm-form": "new" })
    expect(w.writes().slice(2).map((c) => [c.url, c.body])).toEqual([
      [P + "/channels/telegram", { id: "sales", agentBinding: "sales", botTokenEnv: "SALES_TG" }],
      [P + "/channels/slack", { botTokenEnv: "SLACK_BOT", appTokenEnv: "SLACK_APP", agentBinding: "sales", moveBot: true }],
    ])
    expect(page(w)).not.toContain('data-agm-form="new"')
    expect(page(w)).toContain("Created @sales.")
  })

  it("edits in the Sheet, pauses, resumes and removes (after a confirm)", async () => {
    const w = openWall({ hash: "#page=agents" })
    await w.settle()
    await w.click({ "data-agm-act": "edit", "data-id": "cx" })
    expect(page(w)).toContain('class="agm-sheet is-enter" role="dialog" aria-modal="true"')
    expect(page(w)).toContain('data-agm-form="edit" data-id="cx"')
    await w.type("agm-f-model", "model-c")
    await w.submit({ "data-agm-form": "edit", "data-id": "cx" })
    expect(w.writes().at(-1)).toEqual({ method: "PATCH", url: P + "/agents", body: { id: "cx", patch: { model: "model-c" } } })
    await w.click({ "data-agm-act": "pause", "data-id": "cx" })
    expect(w.writes().at(-1)).toEqual({ method: "POST", url: P + "/org/hold", body: { agent: "cx", paused: true } })
    await w.click({ "data-agm-act": "resume", "data-id": "ops" })
    expect(w.writes().at(-1)).toEqual({ method: "POST", url: P + "/org/hold", body: { agent: "ops", paused: false } })
    const before = w.writes().length
    await w.click({ "data-agm-act": "menu", "data-id": "ops" })
    expect(card(w, "ops")).toContain('id="agm-menu" role="menu"')
    await w.click({ "data-agm-act": "ask", "data-id": "ops" })
    expect(w.writes().length).toBe(before)
    expect(page(w)).toContain('role="alertdialog"')
    expect(page(w)).toContain("Remove @ops (Night Shift)?")
    await w.click({ "data-agm-act": "remove", "data-id": "ops" })
    expect(w.writes().at(-1)).toEqual({ method: "DELETE", url: P + "/agents", body: { id: "ops" } })
    expect(page(w)).toContain('data-agm-act="restart"')
  })
})
