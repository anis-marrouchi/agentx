import { describe, it, expect } from "vitest"
import { defaultPushLink, hubOrigin, isPhoneLink, notifyLinks, parseButton } from "../src/notify/links"

describe("push links (#1652)", () => {
  it("accepts http(s) links the phone can reach and refuses loopback ones", () => {
    expect(isPhoneLink("https://hub.example.ts.net/hub")).toBe(true)
    expect(isPhoneLink("http://100.64.0.1:18800/hub")).toBe(true)
    for (const bad of ["http://localhost:18800", "http://127.0.0.1/x", "http://127.1.2.3", "http://[::1]:80/", "http://0.0.0.0", "http://app.localhost", "ftp://example.com", "/hub", "", undefined]) {
      expect(isPhoneLink(bad as any)).toBe(false)
    }
  })

  it("takes the Hub's origin from notifications.publicUrl, else calls.phone.appUrl", () => {
    expect(hubOrigin({ notifications: { publicUrl: "https://a.example.ts.net/" }, calls: { phone: { appUrl: "https://b.example.ts.net" } } })).toBe("https://a.example.ts.net")
    expect(hubOrigin({ calls: { phone: { appUrl: "https://b.example.ts.net" } } })).toBe("https://b.example.ts.net")
    expect(hubOrigin({ notifications: { publicUrl: "http://127.0.0.1:18800" } })).toBeUndefined()
    expect(hubOrigin(undefined)).toBeUndefined()
  })

  it("builds one default link: the request's post, else the Hub", () => {
    expect(defaultPushLink("https://h.example.ts.net", "r-1")).toBe("https://h.example.ts.net/hub#post=r-1")
    expect(defaultPushLink("https://h.example.ts.net")).toBe("https://h.example.ts.net/hub")
    expect(defaultPushLink(undefined, "r-1")).toBeUndefined()
  })

  it("parses --button label=url, keeping = in the link's query", () => {
    expect(parseButton("Watch=https://example.com/v?a=1&b=2")).toEqual({ label: "Watch", url: "https://example.com/v?a=1&b=2" })
    expect(() => parseButton("no link")).toThrow(/label/)
    expect(() => parseButton("=https://example.com")).toThrow()
  })

  it("makes --url the tap link and an Open button, with at most three links", () => {
    expect(notifyLinks("https://example.com/a", ["Docs=https://example.com/d"])).toEqual({
      click: "https://example.com/a",
      buttons: [{ label: "Open", url: "https://example.com/a" }, { label: "Docs", url: "https://example.com/d" }],
    })
    expect(notifyLinks(undefined, undefined)).toEqual({ buttons: [] })
    expect(notifyLinks(undefined, ["B=https://example.com/b"]).click).toBe("https://example.com/b")
    expect(() => notifyLinks("https://example.com/a", ["1=https://e.com/1", "2=https://e.com/2", "3=https://e.com/3"])).toThrow(/at most 3/)
    expect(() => notifyLinks("http://localhost:18800/hub", undefined)).toThrow(/localhost/)
  })
})

import { daemonConfigSchema } from "../src/daemon/config"

describe("notifications.publicUrl (#1652)", () => {
  const parse = (publicUrl: string) => daemonConfigSchema.safeParse({ node: { id: "t", name: "T" }, notifications: { publicUrl } })
  it("takes an origin and refuses localhost", () => {
    expect(parse("https://my-mac.example.ts.net").success).toBe(true)
    expect(parse("http://127.0.0.1:18800").success).toBe(false)
    expect(parse("http://localhost:18800").success).toBe(false)
    expect(parse("https://my-mac.example.ts.net/hub").success).toBe(false)
  })
})
