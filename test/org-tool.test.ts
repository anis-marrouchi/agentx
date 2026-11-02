import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { decideCard, listCards, readCard } from "../src/approvals/cards"
import { runApprovalsSweep, type ApprovalSettings } from "../src/approvals/sweep"
import { readOrgSetup } from "../src/business/org-edit"
import {
  applyOrgProposal, CHANGED_MEANING, handleOrgApi, isOwnerContext, NOT_OWNER, orgProposalLines, readOrgProposal, type OrgApiDeps,
} from "../src/business/org-proposals"
import { runOrgTool } from "../src/business/org-tool"
import { operatorContext } from "../src/requests/operator"
import { orgTreeHtml } from "../src/daemon/ui/pages/org-setup"

// The org chart by chat (#1678 point 5): the agent proposes, one Approvals
// card asks the owner, and on yes the daemon applies it, all or nothing.

const schedule = { days: ["mon"], start: "09:00", end: "17:00" }
function base(): any {
  return {
    agents: { lead: { name: "Lead" }, sales: { name: "Sales" }, cx: { name: "CX" }, dev: { name: "Dev" } },
    people: [{ id: "sam", name: "Sam Doe", role: "owner" }, { id: "kim", name: "Kim Roe" }],
    business: {
      roles: { boss: { title: "Chief" }, eng: { title: "Engineer" } },
      orgChart: {
        lead: { role: "boss", schedule, utilizationTarget: 0.8 },
        sales: { role: "eng", reportsTo: "lead", schedule, utilizationTarget: 0.8 },
        cx: { role: "eng", reportsTo: "lead", schedule, utilizationTarget: 0.8 },
      },
    },
  }
}

let root: string
let cfgPath: string
const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf-8"))
const writeCfg = (c: any) => writeFileSync(cfgPath, JSON.stringify(c, null, 2))

function deps(over: Partial<OrgApiDeps> = {}): OrgApiDeps {
  return {
    root, configPath: cfgPath, settings: { defaultExpiryDays: 3, maxExpiryDays: 30 },
    caller: () => ({ agentId: "cx", owner: true }),
    ...over,
  }
}
const propose = (body: Record<string, unknown>, over: Partial<OrgApiDeps> = {}) => handleOrgApi("POST", "/api/org/proposals", body, deps(over))
const yes = (id: string) => { const r = decideCard(root, id, "yes"); if (!r.ok) throw new Error(r.error); return r.card }
const apply = (card: any) => applyOrgProposal(card, { root, configPath: cfgPath, skipReload: true })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "org-tool-"))
  cfgPath = join(root, "agentx.json")
  writeCfg(base())
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("POST /api/org/proposals", () => {
  it("refuses a turn the owner did not start, and raises no card", () => {
    const r = propose({ changes: [{ op: "remove-relation", from: "agent:cx", type: "reports-to", to: "agent:lead" }] }, { caller: () => ({ agentId: "cx", owner: false }) })
    expect(r).toEqual({ status: 403, body: { error: NOT_OWNER } })
    expect(propose({ changes: [] }, { caller: () => null }).status).toBe(403)
    expect(listCards(root)).toEqual([])
  })

  it.each([
    ["a loop", { op: "add-relation", from: "agent:lead", type: "reports-to", to: "agent:cx" }, "Lead cannot report to CX: CX already reports up to Lead."],
    ["a self line", { op: "add-relation", from: "agent:cx", type: "dotted-line", to: "agent:cx" }, "CX cannot be linked to themself."],
    ["an unknown member", { op: "add-relation", from: "agent:ghost", type: "dotted-line", to: "agent:cx" }, "ghost is not in the org chart. Add them first."],
  ])("refuses %s in a plain sentence, and raises no card", (_what, change, sentence) => {
    const r = propose({ changes: [change] })
    expect(r).toEqual({ status: 422, body: { error: sentence } })
    expect(listCards(root)).toEqual([])
  })

  it("refuses all of it when one change of several is refused", () => {
    const r = propose({ changes: [
      { op: "add-relation", from: "agent:cx", type: "dotted-line", to: "agent:sales" },
      { op: "remove-relation", from: "agent:dev", type: "reports-to", to: "agent:lead" },
    ] })
    expect(r).toEqual({ status: 422, body: { error: "That line is not in the org chart any more." } })
    expect(listCards(root)).toEqual([])
  })

  it("raises one card for a valid change and writes nothing before yes", () => {
    const before = readFileSync(cfgPath, "utf-8")
    const r = propose({ changes: [{ op: "add-relation", from: "agent:cx", type: "reports-to", to: "agent:sales" }], why: "The owner asked in chat" })
    expect(r.status).toBe(201)
    const cards = listCards(root)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      title: "Change the org chart", raised_by: "cx", if_silent: "discard", recommend: "The owner asked in chat", origin: { kind: "org-proposal" },
    })
    expect(cards[0].ask).toBe("CX will report to Sales, not Lead. When CX is stuck, it asks Sales first. Apply?")
    expect(readFileSync(cfgPath, "utf-8")).toBe(before)
    expect(readOrgProposal(root, cards[0].id)).toMatchObject({ status: "pending", raised_by: "cx" })
  })

  it("applies on yes, in one write, and the line is in the chart", () => {
    propose({ changes: [{ op: "add-relation", from: "agent:cx", type: "reports-to", to: "agent:sales" }, { op: "add-member", member: "person:sam" }, { op: "add-relation", from: "agent:cx", type: "acts-for", to: "person:sam" }] })
    const [card] = listCards(root)
    const done = apply(yes(card.id))!
    expect(done.status).toBe("applied")
    const setup = readOrgSetup(readCfg())
    expect(setup.relations).toContainEqual({ from: "agent:cx", to: "agent:sales", type: "reports-to" })
    expect(setup.relations).toContainEqual({ from: "agent:cx", to: "person:sam", type: "acts-for" })
    expect(handleOrgApi("GET", "/api/org", undefined, deps()).body).toMatchObject({ text: expect.stringContaining("agent:cx reports-to agent:sales (CX reports to Sales)") })
    // Once: a second call changes nothing.
    expect(apply(readCard(root, card.id)!)!.status).toBe("applied")
  })

  it("allows removing a line", () => {
    propose({ changes: [{ op: "remove-relation", from: "agent:cx", type: "reports-to", to: "agent:lead" }] })
    const [card] = listCards(root)
    expect(card.ask).toBe("CX will no longer report to Lead. When CX is stuck, it no longer asks Lead. Apply?")
    expect(apply(yes(card.id))!.status).toBe("applied")
    expect(readCfg().business.orgChart.cx.reportsTo).toBeUndefined()
  })

  it("checks again on yes when the chart changed, and refuses what no longer holds", () => {
    propose({ changes: [{ op: "add-relation", from: "agent:cx", type: "reports-to", to: "agent:sales" }] })
    const [card] = listCards(root)
    // Meanwhile, Sales was put under CX on the editor.
    const c = readCfg()
    c.business.orgChart.sales.reportsTo = "cx"
    writeCfg(c)
    const before = readFileSync(cfgPath, "utf-8")
    const done = apply(yes(card.id))!
    expect(done).toMatchObject({ status: "failed", result: "CX cannot report to Sales: Sales already reports up to CX." })
    expect(readFileSync(cfgPath, "utf-8")).toBe(before)
    expect(orgProposalLines(done)[0]).toContain("Nothing was changed")
  })

  it("refuses on yes when the chart changed and the changes would now mean something else", () => {
    propose({ changes: [{ op: "add-relation", from: "agent:cx", type: "reports-to", to: "agent:sales" }] })
    const [card] = listCards(root)
    expect(card.ask).toContain("not Lead")
    // Meanwhile CX was moved under Dev: the same change would now replace Dev, not Lead.
    const c = readCfg()
    c.business.orgChart.cx.reportsTo = "dev"
    writeCfg(c)
    const before = readFileSync(cfgPath, "utf-8")
    const done = apply(yes(card.id))!
    expect(done).toMatchObject({ status: "failed", result: CHANGED_MEANING })
    expect(readFileSync(cfgPath, "utf-8")).toBe(before)
  })

  it("applies on yes after a change elsewhere when it still holds, and says so", () => {
    propose({ changes: [{ op: "add-relation", from: "agent:cx", type: "dotted-line", to: "agent:sales" }] })
    const [card] = listCards(root)
    const c = readCfg()
    c.business.roles.new = { title: "New" }
    writeCfg(c)
    const done = apply(yes(card.id))!
    expect(done.status).toBe("applied")
    expect(done.result).toContain("checked again")
  })

  it("drops the proposal on no, writing nothing", () => {
    propose({ changes: [{ op: "remove-member", member: "agent:cx" }] })
    const [card] = listCards(root)
    const r = decideCard(root, card.id, "no")
    if (!r.ok) throw new Error(r.error)
    const before = readFileSync(cfgPath, "utf-8")
    expect(apply(r.card)!.status).toBe("dropped")
    expect(readFileSync(cfgPath, "utf-8")).toBe(before)
  })

  it("adds a new agent under someone in the same yes", () => {
    propose({ newAgent: { id: "support", name: "Support", role: "Engineer", reportsTo: "agent:cx" } })
    const [card] = listCards(root)
    expect(card.title).toBe("Add Support to the org chart")
    expect(card.ask).toContain(`workspace ${join(root, "agents", "support")}`)
    expect(readCfg().agents.support).toBeUndefined()
    expect(apply(yes(card.id))!.status).toBe("applied")
    const cfg = readCfg()
    expect(cfg.agents.support).toMatchObject({ name: "Support", workspace: join(root, "agents", "support") })
    expect(cfg.business.orgChart.support).toMatchObject({ role: "eng", reportsTo: "cx" })
    expect(existsSync(join(root, "agents", "support", "CLAUDE.md"))).toBe(true)
  })

  it("goes through the approvals sweep: the hook applies, the agent hears the result", async () => {
    propose({ changes: [{ op: "add-relation", from: "agent:cx", type: "reports-to", to: "agent:sales" }] })
    const [card] = listCards(root)
    yes(card.id)
    const told: string[] = []
    const settings = { defaultExpiryDays: 3, maxExpiryDays: 30, laterHours: 4, notifyAgent: true, digest: { enabled: false, time: "09:00" } } as ApprovalSettings
    await runApprovalsSweep({
      ctx: { root }, settings, log: () => {},
      onCardResult: (c) => { apply(c) },
      tellAgent: async (_a, text, c) => { told.push([text, ...orgProposalLines(readOrgProposal(root, c.id))].join("\n")) },
    })
    expect(readCfg().business.orgChart.cx.reportsTo).toBe("sales")
    expect(told).toHaveLength(1)
    expect(told[0]).toContain("The daemon applied it to the org chart: CX will report to Sales, not Lead.")
  })
})

describe("isOwnerContext", () => {
  const settings = { from: ["telegram:111"] }
  const people = [{ id: "sam", name: "Sam", role: "owner", identities: ["whatsapp:21620000000"] }] as any

  it("is the owner on a listed chat id, or on a dashboard turn the daemon marked", () => {
    expect(isOwnerContext({ channel: "telegram", chatId: "1", senderId: "111" }, settings, people)).toBe(true)
    expect(isOwnerContext(operatorContext({ channel: "dashboard", chatId: "a", sender: "operator" }), settings, people)).toBe(true)
    // A listed person with the owner role, on a channel not in requests.from.
    expect(isOwnerContext({ channel: "whatsapp", chatId: "c", senderId: "21620000000" }, settings, people)).toBe(true)
  })

  it("is not the owner for a contact, a schedule, a2a, another agent, a delegation or an unmarked dashboard turn", () => {
    expect(isOwnerContext({ channel: "telegram", chatId: "1", senderId: "222" }, settings, people)).toBe(false)
    expect(isOwnerContext({ channel: "cron", chatId: "job" }, settings, people)).toBe(false)
    expect(isOwnerContext({ channel: "a2a", chatId: "x", sender: "agent:lead" }, settings, people)).toBe(false)
    expect(isOwnerContext({ channel: "telegram", chatId: "1", senderId: "111", sender: "agent:lead" }, settings, people)).toBe(false)
    expect(isOwnerContext({ channel: "telegram", chatId: "1", senderId: "111", initiator: { kind: "human", channel: "telegram" } }, settings, people)).toBe(false)
    expect(isOwnerContext({ channel: "dashboard", chatId: "a", sender: "operator" }, settings, people)).toBe(false)
    expect(isOwnerContext(null, settings, people)).toBe(false)
  })
})

describe("agentx_org tool", () => {
  it("shows the chart and proposes through the daemon, never writing", async () => {
    const calls: Array<{ url: string; init?: any }> = []
    const fetch = (async (url: string, init?: any) => {
      calls.push({ url, init })
      const r = url.endsWith("/api/org")
        ? handleOrgApi("GET", "/api/org", undefined, deps())
        : handleOrgApi("POST", "/api/org/proposals", JSON.parse(init.body), deps())
      return new Response(JSON.stringify(r.body), { status: r.status })
    }) as typeof globalThis.fetch
    const env = { AGENTX_AGENT_ID: "cx", AGENTX_TASK_ID: "t1" }
    const shown = await runOrgTool({}, { daemonUrl: "http://d", fetch, env })
    expect(shown).toContain("- agent:cx: CX, agent, role Engineer")
    expect(shown).toContain("- person:sam: Sam Doe")
    const said = await runOrgTool({ action: "propose", changes: [{ op: "add-relation", from: "agent:cx", type: "self", to: "agent:sales" }] }, { daemonUrl: "http://d", fetch, env })
    expect(said).toMatch(/^Not proposed: "self" is not a kind of relation/)
    const ok = await runOrgTool({ action: "propose", changes: [{ op: "add-relation", from: "agent:cx", type: "dotted-line", to: "agent:sales" }] }, { daemonUrl: "http://d", fetch, env })
    expect(ok).toContain("Nothing is changed yet")
    expect(calls[2].init.headers["X-AgentX-Task"]).toBe("t1")
    expect(listCards(root)).toHaveLength(1)
  })
})

describe("orgTreeHtml (Settings → Business, above the editor)", () => {
  it("nests each member under its boss, with other lines in words", () => {
    const html = orgTreeHtml(readOrgSetup({ ...base(), business: { ...base().business, relations: [{ from: "agent:cx", to: "person:sam", type: "acts-for" }] } }))
    expect(html).toMatch(/^<ul class="oe-tree"/)
    expect(html).toContain("<li><b>Lead</b>")
    expect(html).toMatch(/<b>Lead<\/b>.*<ul><li><b>Sales<\/b>.*<li><b>CX<\/b>.*acts for Sam Doe/)
    expect(orgTreeHtml({ members: [], relations: [] })).toBe("")
  })
})
