import { describe, it, expect } from "vitest"
import { classifyBrowserRequest, isStateChangingOrPreflight, allowedOriginsFromEnv } from "../src/daemon/browser-origin"
import { decideMeshAuth } from "../src/daemon/mesh-auth"

const none = new Set<string>()

describe("classifyBrowserRequest", () => {
  it("treats curl, the CLI, native apps and servers (no browser markers) as none", () => {
    expect(classifyBrowserRequest({ host: "localhost:18800" }, none)).toBe("none")
    expect(classifyBrowserRequest({ host: "localhost:18800", "sec-fetch-site": "none" }, none)).toBe("none")
  })

  it("accepts a page served by this same server", () => {
    expect(classifyBrowserRequest({ host: "127.0.0.1:4202", origin: "http://127.0.0.1:4202" }, none)).toBe("same-origin")
    expect(classifyBrowserRequest({ host: "100.64.0.1:4202", origin: "http://100.64.0.1:4202", "sec-fetch-site": "same-origin" }, none)).toBe("same-origin")
  })

  it("flags any other origin, including localhost on another port", () => {
    expect(classifyBrowserRequest({ host: "localhost:18800", origin: "https://evil.example" }, none)).toBe("foreign")
    expect(classifyBrowserRequest({ host: "localhost:18800", origin: "http://localhost:3000" }, none)).toBe("foreign")
    expect(classifyBrowserRequest({ host: "localhost:18800", origin: "http://127.0.0.1:4202" }, none)).toBe("foreign")
  })

  it("flags opaque origins from sandboxed frames and files", () => {
    expect(classifyBrowserRequest({ host: "localhost:18800", origin: "null" }, none)).toBe("foreign")
  })

  it("flags cross-site and same-site requests that carry no Origin (image loads, navigations)", () => {
    expect(classifyBrowserRequest({ host: "localhost:18800", "sec-fetch-site": "cross-site" }, none)).toBe("foreign")
    expect(classifyBrowserRequest({ host: "localhost:18800", "sec-fetch-site": "same-site" }, none)).toBe("foreign")
  })

  it("trusts a reverse proxy's forwarded host and origins listed in AGENTX_ALLOWED_ORIGINS", () => {
    expect(classifyBrowserRequest({ host: "127.0.0.1:4202", "x-forwarded-host": "dash.example", origin: "https://dash.example" }, none)).toBe("same-origin")
    const extra = allowedOriginsFromEnv({ AGENTX_ALLOWED_ORIGINS: "https://Ops.Example/ , http://10.0.0.5:4202" })
    expect(classifyBrowserRequest({ host: "127.0.0.1:18800", origin: "https://ops.example" }, extra)).toBe("same-origin")
    expect(classifyBrowserRequest({ host: "127.0.0.1:18800", origin: "http://10.0.0.5:4202" }, extra)).toBe("same-origin")
  })
})

describe("isStateChangingOrPreflight", () => {
  it("lets reads through and stops writes and preflights", () => {
    expect(isStateChangingOrPreflight("GET")).toBe(false)
    expect(isStateChangingOrPreflight("HEAD")).toBe(false)
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "post"]) expect(isStateChangingOrPreflight(m)).toBe(true)
  })
})

describe("decideMeshAuth — pages on another origin", () => {
  const tokens = new Set(["mesh-secret"])
  it("refuses a foreign page even though its browser is on loopback", () => {
    expect(decideMeshAuth({ remoteAddress: "127.0.0.1", authorizationHeader: "", acceptedTokens: tokens, foreignBrowser: true }))
      .toEqual({ allowed: false, reason: "foreign-browser-origin" })
  })
  it("refuses it on a node with no tokens and with enforcement switched off", () => {
    expect(decideMeshAuth({ remoteAddress: "127.0.0.1", authorizationHeader: "", acceptedTokens: new Set(), foreignBrowser: true }).allowed).toBe(false)
    expect(decideMeshAuth({ remoteAddress: "127.0.0.1", authorizationHeader: "", acceptedTokens: tokens, enforcementDisabled: true, foreignBrowser: true }).allowed).toBe(false)
  })
  it("leaves the operator's own loopback tools alone", () => {
    expect(decideMeshAuth({ remoteAddress: "127.0.0.1", authorizationHeader: "", acceptedTokens: tokens, foreignBrowser: false }).allowed).toBe(true)
  })
})
