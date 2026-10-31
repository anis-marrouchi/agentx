import { describe, it, expect, vi, afterEach } from "vitest"
import { NtfyAdapter } from "../src/channels/ntfy"
import { buildPushPayload, PushRelayAdapter } from "../src/channels/push"
import { phonePublicUrl } from "../src/notify/phone-link"

// #1655 follow-up to #1652: calls.phone.appUrl fallback, a live address,
// and Web Push opening the push's request.

afterEach(() => { vi.restoreAllMocks() })

describe("phonePublicUrl", () => {
  it("takes notifications.publicUrl, else calls.phone.appUrl", () => {
    expect(phonePublicUrl({ notifications: { publicUrl: "https://a.example.ts.net/" }, calls: { phone: { appUrl: "https://b.example.ts.net" } } })).toBe("https://a.example.ts.net")
    expect(phonePublicUrl({ notifications: {}, calls: { phone: { appUrl: "https://b.example.ts.net" } } })).toBe("https://b.example.ts.net")
    expect(phonePublicUrl({ calls: { phone: { appUrl: "http://127.0.0.1:18800" } } })).toBeUndefined()
    expect(phonePublicUrl(undefined)).toBeUndefined()
  })
})

describe("ntfy reads the address on each send", () => {
  it("follows a changed address without a new adapter", async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "m" }), text: async () => "" }))
    ;(globalThis as any).fetch = fn
    let origin: string | undefined
    const a = new NtfyAdapter({ topic: "t", publicUrl: () => origin }, () => {})
    await a.send({ channel: "ntfy", chatId: "", text: "hi" })
    origin = "https://my-mac.example.ts.net"
    await a.send({ channel: "ntfy", chatId: "", text: "hi" })
    expect((fn.mock.calls[0] as any)[1].headers["Click"]).toBeUndefined()
    expect((fn.mock.calls[1] as any)[1].headers["Click"]).toBe("https://my-mac.example.ts.net/hub")
  })
})

describe("Web Push tap link", () => {
  it("opens the push's request when it has no button", () => {
    expect(buildPushPayload({ channel: "push", chatId: "default", text: "hi", open: "/hub#post=r-1" }).url).toBe("/hub#post=r-1")
  })

  it("prefers a button, and ignores an open that is not a local path", () => {
    expect(buildPushPayload({ channel: "push", chatId: "default", text: "hi", open: "/hub#post=r-1", buttons: [{ label: "B", url: "https://example.com/b" }] }).url).toBe("https://example.com/b")
    expect(buildPushPayload({ channel: "push", chatId: "default", text: "hi", open: "//evil.example.com" }).url).toBe("/app#alerts")
  })

  it("a relay carries the request link to the host", async () => {
    const forward = vi.fn(async () => "1")
    await new PushRelayAdapter("host", forward, () => {}).send({ channel: "push", chatId: "default", text: "hi", open: "/hub#post=r-1" })
    expect((forward.mock.calls[0] as any)[1].open).toBe("/hub#post=r-1")
  })
})
