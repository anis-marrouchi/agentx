import { describe, expect, it } from "vitest"
import type { IncomingMessage, ServerResponse } from "http"
import { renderAppPage } from "../src/daemon/ui/pages/app"
import { APP_AGENTS_SCRIPT } from "../src/daemon/ui/pages/app-agents.client"
import { haGroups, haListHtml, haRowHref, haRowHtml, haRunsHtml, haStateIcon, haStateWord, type HaModel, type HaRow } from "../src/daemon/ui/pages/hub-agents"
import { APP_AGENTS_PATH, handleAppAgents, hubDayStart } from "../src/daemon/hub-agents-api"
import { injectFns } from "../src/daemon/ui/inject"

// The phone's Agents tab and bottom tabs (#2101 C1a): the Hub's agent rows
// on the phone, behind the paired phone's device token.

const DAY = 86_400_000
const NOW = Date.parse("2026-11-26T13:00:00Z")

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {}
  const res = {
    writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; return res },
    end(body: string) { out.body = body },
  } as unknown as ServerResponse
  return { res, out }
}
const req = (url: string) => ({ url } as IncomingMessage)

describe("the bottom tabs (#2101 C1a)", () => {
  const html = renderAppPage()
  const tabs = [...html.matchAll(/data-tab="(\w+)"/g)].map((m) => m[1])

  it("are Agents · Chat · Desk · Alerts · More, Agents first and selected", () => {
    expect(tabs).toEqual(["agents", "chat", "desk", "alerts", "more"])
    expect(html).toContain('id="tab-agents" aria-controls="panel-agents" aria-selected="true"')
  })

  it("keep Fleet and Activity as pages under More, with a way back", () => {
    for (const p of ["fleet", "activity"]) {
      expect(html).toContain(`<a href="#${p}" data-more="${p}">`)
      expect(html).toContain(`id="panel-${p}" aria-labelledby="tab-more" tabindex="0" data-more-page hidden`)
    }
    expect(html.match(/class="more-back" href="#more"/g)).toHaveLength(2)
  })

  it("ship the Agents script with every list function it calls, and it parses", () => {
    const script = injectFns({ haStateIcon, haStateWord, haRowHref, haGroups, haRunsHtml, haRowHtml, haListHtml }) + APP_AGENTS_SCRIPT
    expect(html).toContain(script)
    // With the Hub's lucide icons, so the folds and states draw the same.
    expect(html).toMatch(/<script>var HA_IC = \{"circle-alert":"<svg /)
    expect(APP_AGENTS_SCRIPT).not.toContain("data-ha-filter")
    expect(() => new Function(script)).not.toThrow()
    expect(APP_AGENTS_SCRIPT).toContain("fetch('/api/app/hub/agents?dayStart='")
  })

  it("finds the placeholder the Agents panel really renders (#2152 loader)", () => {
    const panel = html.slice(html.indexOf('id="panel-agents"'), html.indexOf('id="panel-chat"'))
    const sel = /panel\.querySelector\('\.([\w-]+)'\)/.exec(APP_AGENTS_SCRIPT)?.[1]
    expect(sel).toBe("ax-af-loader")
    expect(panel).toContain(`class="${sel}"`)
    expect(APP_AGENTS_SCRIPT).not.toContain("querySelector('.soon')")
  })
})

describe("the rows the phone draws", () => {
  const row = (id: string, state: HaRow["state"], extra: Partial<HaRow> = {}): HaRow => ({
    id, name: id, node: "mac", face: id[0].toUpperCase(), state, line: state + " line", ageMs: 60_000, unread: 0, ...extra,
  } as HaRow)
  const model: HaModel = {
    rows: [row("coder", "working", { taskId: "t1" }), row("pm", "needs", { unread: 1 }), row("cx", "done"), row("nadia", "idle")],
    counts: { all: 3, working: 1, needs: 1, failed: 0, done: 1, idle: 1 },
  }
  const esc = (s: unknown) => String(s)
  const age = () => "1 min"

  it("open the agent's chat on every row, never a run link (no runHref on the phone)", () => {
    const out = haListHtml(model, "", { needs: true, idle: true }, esc, age)
    for (const id of ["coder", "pm", "cx", "nadia"]) expect(out).toContain(`data-ha-agent="${id}"><a class="ha__link" href="#page=chat&agent=${id}">`)
    expect(out).not.toContain("data-ha-run")
  })

  it("keep Needs you and Not working today closed until opened", () => {
    const closed = haListHtml(model, "", { needs: false, working: false, idle: false }, esc, age)
    expect(closed).toContain('<details class="ha__fold" data-key="g:needs" data-ha-open="needs">')
    expect(closed).toContain('data-ha-open="idle">')
    expect(APP_AGENTS_SCRIPT).toContain("getAttribute('data-ha-open')")
    expect(APP_AGENTS_SCRIPT).toContain("closest('[data-ha-more]')")
  })
})

describe("one chevron per fold (#2101 C2)", () => {
  it("turn the Fleet tab's summary › off on the Agents list, after the rule that adds it", () => {
    const html = renderAppPage()
    const add = html.indexOf('summary::before { content: "›"')
    const off = html.indexOf(".ag .ha__h::before { content: none")
    expect(add).toBeGreaterThan(-1)
    expect(off).toBeGreaterThan(add)
  })
})

describe("GET /api/app/hub/agents", () => {
  it("answers with the Hub's rows for the viewer's day", async () => {
    const asked: number[][] = []
    const { res, out } = fakeRes()
    const local = NOW - 3_600_000
    const done = await handleAppAgents(req(`${APP_AGENTS_PATH}?dayStart=${local}`), res, APP_AGENTS_PATH, "GET", {
      rows: async (dayStart, now) => { asked.push([dayStart, now]); return { rows: [], counts: {} } },
    })
    expect(done).toBe(true)
    expect(out.status).toBe(200)
    expect(out.headers?.["Cache-Control"]).toBe("no-store")
    expect(JSON.parse(out.body!)).toEqual({ rows: [], counts: {} })
    expect(asked[0][0]).toBe(local)
  })

  it("leaves the chat picker's /api/app/agents and other paths alone", async () => {
    const { res, out } = fakeRes()
    expect(await handleAppAgents(req("/api/app/agents"), res, "/api/app/agents", "GET", { rows: async () => ({}) })).toBe(false)
    expect(out.status).toBeUndefined()
  })

  it("refuses anything but GET, and says 502 when the machines cannot be read", async () => {
    const a = fakeRes()
    await handleAppAgents(req(APP_AGENTS_PATH), a.res, APP_AGENTS_PATH, "POST", { rows: async () => ({}) })
    expect(a.out.status).toBe(405)
    const b = fakeRes()
    await handleAppAgents(req(APP_AGENTS_PATH), b.res, APP_AGENTS_PATH, "GET", { rows: async () => { throw new Error("no snapshot") } })
    expect(b.out.status).toBe(502)
    expect(JSON.parse(b.out.body!)).toEqual({ error: "no snapshot" })
  })
})

describe("hubDayStart", () => {
  const utcMidnight = Date.parse("2026-11-26T00:00:00Z")
  it("takes the viewer's midnight when it is within two days", () => {
    expect(hubDayStart(String(NOW - 5 * 3_600_000), NOW)).toBe(NOW - 5 * 3_600_000)
  })
  it("falls back to UTC midnight for missing, future, stale or junk values", () => {
    for (const v of [null, "", "abc", String(NOW + 1000), String(NOW - 3 * DAY)]) expect(hubDayStart(v, NOW)).toBe(utcMidnight)
  })
})
