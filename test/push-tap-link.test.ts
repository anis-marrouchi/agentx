import { describe, it, expect, vi, afterEach } from "vitest"
import { NtfyAdapter, clickUrl } from "../src/channels/ntfy"
import { MessageRouter } from "../src/channels/router"
import { pushButtons } from "../src/commands/notify"
import { daemonConfigSchema } from "../src/daemon/config"
import { isPhoneLink } from "../src/notify/phone-link"

// #1652: a tap on a phone push opens something.

function mockFetch() {
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "m" }), text: async () => "" }))
  ;(globalThis as any).fetch = fn
  return fn
}

const quiet = () => {}
const BASE = "https://my-mac.example.ts.net"

async function headersFor(msg: Record<string, unknown>, publicUrl?: string): Promise<Record<string, string>> {
  const fetchMock = mockFetch()
  await new NtfyAdapter({ topic: "t", publicUrl }, quiet).send({ channel: "ntfy", chatId: "", text: "Done\nthe video is ready", ...msg })
  return (fetchMock.mock.calls[0] as any)[1].headers
}

afterEach(() => { vi.restoreAllMocks() })

describe("ntfy Click header", () => {
  it("opens the push's own link and keeps it as a view action", async () => {
    const h = await headersFor({ buttons: [{ label: "Open", url: "https://example.com/video" }] }, BASE)
    expect(h["Click"]).toBe("https://example.com/video")
    expect(h["Actions"]).toBe("view, Open, https://example.com/video")
  })

  it("opens the request on the Hub when the push has no link", async () => {
    const h = await headersFor({ open: "/hub#post=req-42" }, BASE)
    expect(h["Click"]).toBe(`${BASE}/hub#post=req-42`)
    expect(h["Actions"]).toBeUndefined()
  })

  it("opens the Hub when there is neither a link nor a request", async () => {
    expect((await headersFor({}, `${BASE}/`))["Click"]).toBe(`${BASE}/hub`)
  })

  it("sets no Click without a public address", async () => {
    expect((await headersFor({ open: "/hub#post=req-42" }))["Click"]).toBeUndefined()
  })

  it("never sends a loopback link to the phone", async () => {
    const h = await headersFor({ buttons: [{ label: "Local", url: "http://127.0.0.1:18800/hub" }] }, BASE)
    expect(h["Actions"]).toBeUndefined()
    expect(h["Click"]).toBe(`${BASE}/hub`)
    expect(clickUrl(undefined, "/hub", "http://localhost:18800")).toBeUndefined()
  })

  it("lets a ringing call keep its own link", async () => {
    const h = await headersFor({ ring: { callId: "c1", state: "ringing", urgent: false, url: `${BASE}/app#call=c1` }, buttons: [{ label: "x", url: "https://example.com" }] }, BASE)
    expect(h["Click"]).toBe(`${BASE}/app#call=c1`)
  })
})

describe("the router", () => {
  it("turns a push's request into the Hub path it opens", async () => {
    const send = vi.fn(async () => "id")
    const r = new MessageRouter({ getAgent: () => undefined, refusalFor: () => null } as any, { channels: {} } as any, undefined, () => {})
    r.addChannel({ name: "ntfy", start: async () => {}, stop: async () => {}, onMessage: () => {}, send } as any)
    await r.sendOutbound({ channel: "ntfy", chatId: "default", text: "a\nb", told: { requestId: "req 7" } })
    await r.sendOutbound({ channel: "ntfy", chatId: "default", text: "a\nb" })
    expect((send.mock.calls[0] as any)[0]).toMatchObject({ open: "/hub#post=req%207" })
    expect((send.mock.calls[0] as any)[0].told).toBeUndefined()
    expect((send.mock.calls[1] as any)[0].open).toBeUndefined()
  })
})

describe("agentx notify --url / --button", () => {
  it("puts --url first, so it is what a tap opens", () => {
    expect(pushButtons("https://a.example/x", ["Logs=https://a.example/logs"])).toEqual([
      { label: "Open", url: "https://a.example/x" },
      { label: "Logs", url: "https://a.example/logs" },
    ])
    expect(pushButtons(undefined, [])).toEqual([])
  })

  it("refuses more than three, a malformed button and a loopback link", () => {
    expect(() => pushButtons("https://a.example", ["b=https://b.example", "c=https://c.example", "d=https://d.example"])).toThrow(/at most 3/)
    expect(() => pushButtons(undefined, ["https://b.example"])).toThrow(/<label>=<url>/)
    expect(() => pushButtons("http://localhost:18800/hub")).toThrow(/not a link the phone can open/)
  })
})

describe("notifications.publicUrl", () => {
  it("takes a reachable origin and refuses loopback", () => {
    const parse = (publicUrl: string) => daemonConfigSchema.safeParse({ node: { id: "n", name: "n" }, notifications: { publicUrl } }).success
    expect(parse(BASE)).toBe(true)
    expect(parse("http://127.0.0.1:18800")).toBe(false)
    expect(parse("http://localhost:18800")).toBe(false)
    expect(parse(`${BASE}/hub`)).toBe(false)
  })

  it("knows a phone link", () => {
    expect(isPhoneLink("https://100.64.0.1/hub")).toBe(true)
    expect(["http://[::1]:1/", "http://app.localhost/", "ftp://x.example/", "not a url", undefined].some(isPhoneLink)).toBe(false)
  })
})
