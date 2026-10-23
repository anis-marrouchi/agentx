import { describe, expect, it, vi } from "vitest"
import { Readable } from "stream"
import { handleAppDesk, DESK_REPLY_MAX, type AppDeskDeps } from "../src/daemon/app-desk"
import { APP_DESK_SCRIPT } from "../src/daemon/ui/pages/app-desk.client"
import { APP_FLEET_SCRIPT } from "../src/daemon/ui/pages/app-fleet.client"
import { renderAppPage } from "../src/daemon/ui/pages/app"

// The phone app's Desk tab (#959): its two routes, and the script on the page.

const board = { ts: "2026-01-05T12:00:00Z", cards: [], figures: { yours: { count: 0 }, agent: { count: 0 }, quiet: { count: 0 }, done: { count: 0 } }, errors: [] }

function deps(over: Partial<AppDeskDeps> = {}): AppDeskDeps {
  return {
    board: vi.fn(async () => board),
    reply: vi.fn(async () => ({ status: 200, body: { ok: true, message: "Reply sent" } })),
    ...over,
  }
}

async function call(d: AppDeskDeps, method: string, path: string, body?: unknown) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]) as any
  req.url = path
  req.headers = {}
  const out: { status?: number; body?: any } = {}
  const res: any = {
    writeHead(s: number) { out.status = s },
    end(b: string) { out.body = JSON.parse(b) },
  }
  const handled = await handleAppDesk(req, res, path, method, d)
  return { handled, ...out }
}

describe("/api/app/desk", () => {
  it("serves the board as it is read", async () => {
    const d = deps()
    expect(await call(d, "GET", "/api/app/desk")).toEqual({ handled: true, status: 200, body: board })
    expect(d.board).toHaveBeenCalledOnce()
  })

  it("leaves other paths to the next handler", async () => {
    expect((await call(deps(), "GET", "/api/app/desk/other")).handled).toBe(false)
    expect((await call(deps(), "POST", "/api/app/desk")).handled).toBe(false)
  })

  it("passes a written answer on, trimmed, and returns what the source said", async () => {
    const d = deps()
    const r = await call(d, "POST", "/api/app/desk/reply", { id: " req-1 ", text: "  Use the blue cover.  " })
    expect(r).toMatchObject({ status: 200, body: { message: "Reply sent" } })
    expect(d.reply).toHaveBeenCalledWith("req-1", "Use the blue cover.")
    const refused = deps({ reply: vi.fn(async () => ({ status: 409, body: { error: "req-1 is already closed" } })) })
    expect(await call(refused, "POST", "/api/app/desk/reply", { id: "req-1", text: "x" })).toMatchObject({ status: 409, body: { error: "req-1 is already closed" } })
  })

  it("refuses an empty, oversized or malformed answer without touching the request", async () => {
    const d = deps()
    expect((await call(d, "POST", "/api/app/desk/reply", { id: "req-1", text: "   " })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/desk/reply", { text: "hello" })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/desk/reply", { id: "req-1", text: "x".repeat(DESK_REPLY_MAX + 1) })).status).toBe(400)
    expect((await call(d, "POST", "/api/app/desk/reply", "not json")).status).toBe(400)
    expect(d.reply).not.toHaveBeenCalled()
  })
})

describe("the desk script", () => {
  it("parses and is on the page after the script whose sheet it asks through", () => {
    expect(() => new Function(APP_DESK_SCRIPT)).not.toThrow()
    expect(() => new Function(APP_FLEET_SCRIPT)).not.toThrow()
    const html = renderAppPage()
    expect(html).toContain('id="panel-desk"')
    expect(html).toContain(APP_DESK_SCRIPT)
    expect(html.indexOf("window.AXAsk = ")).toBeLessThan(html.indexOf(APP_DESK_SCRIPT))
  })

  it("keeps no card of its own: it draws what the board route returns", () => {
    expect(APP_DESK_SCRIPT).toContain("ax.api('GET', '/api/app/desk')")
    expect(APP_DESK_SCRIPT).not.toContain("localStorage")
  })
})
