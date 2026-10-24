import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, type IncomingHttpHeaders, type Server } from "http"
import { runInNewContext } from "vm"
import type { AddressInfo } from "net"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { TOPBAR_SCRIPT } from "../src/daemon/topbar"

// #1203: the dashboard checks dashboard.token before it proxies to a peer, so
// the topbar's fetch wrapper must send the token on peer-proxied calls, also
// for routes with no local gate (/api/agents, /api/workflows) that pages
// fetch without an Authorization header.

let peer: Server
let dash: Server
let dashBase: string
let peerUrl: string
let seenByPeer: IncomingHttpHeaders[] = []

function listen(s: Server): Promise<string> {
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)))
}

/** The topbar script run against a stub page, with fetch going to `dashBase`. */
function page(opts: { peer?: string; axToken?: string; localToken?: string }) {
  const store: Record<string, string> = {}
  if (opts.peer) store["ax-peer"] = opts.peer
  if (opts.axToken) store["ax_token"] = opts.axToken
  const sent: { url: string; headers: Headers }[] = []
  const window: any = {
    AX_LOCAL_TOKEN: opts.localToken,
    fetch: (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url
      sent.push({ url, headers: new Headers(init?.headers ?? input?.headers ?? {}) })
      return fetch(new URL(url, dashBase), init)
    },
  }
  const document = {
    readyState: "loading",
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
  }
  const src = TOPBAR_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, "")
  runInNewContext(src, { window, document, localStorage, Headers, location: { hostname: "localhost" }, setInterval() {} })
  return { fetch: window.fetch as (input: any, init?: any) => Promise<Response>, sent }
}

beforeAll(async () => {
  peer = createServer((req, res) => {
    seenByPeer.push(req.headers)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ agents: [{ id: "remote-agent" }] }))
  })
  peerUrl = await listen(peer)
  const config = daemonConfigSchema.parse({
    node: { id: "node-a", name: "node-a" },
    dashboard: { token: "dash-tok", daemons: [{ name: "node-b", url: peerUrl, dashboardUrl: peerUrl, token: "peer-tok" }] },
  })
  dash = createServer((req, res) => {
    void handleBoardRequest(req, res, { boards: [], sources: new Map(), token: "dash-tok", config } as unknown as Ctx)
  })
  dashBase = await listen(dash)
})

afterAll(async () => {
  await new Promise<void>((r) => dash.close(() => r()))
  await new Promise<void>((r) => peer.close(() => r()))
})

describe("topbar peer proxy", () => {
  it("gets a peer-proxied /api/agents through the token gate with the stored token", async () => {
    seenByPeer = []
    const p = page({ peer: peerUrl, axToken: "dash-tok" })
    const res = await p.fetch("/api/agents")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ agents: [{ id: "remote-agent" }] })
    expect(p.sent[0].headers.get("Authorization")).toBe("Bearer dash-tok")
    expect(p.sent[0].headers.get("X-Agentx-Peer")).toBe(peerUrl)
    // The peer sees its own token, never the caller's.
    expect(seenByPeer[0].authorization).toBe("Bearer peer-tok")
  })

  it("prefers the page's local token and keeps a caller's own Authorization", async () => {
    const a = page({ peer: peerUrl, axToken: "stale", localToken: "dash-tok" })
    expect((await a.fetch("/api/workflows")).status).toBe(200)
    expect(a.sent[0].headers.get("Authorization")).toBe("Bearer dash-tok")
    const b = page({ peer: peerUrl, axToken: "dash-tok" })
    expect((await b.fetch("/api/agents", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401)
    expect(b.sent[0].headers.get("Authorization")).toBe("Bearer wrong")
  })

  it("adds nothing on the primary node or off the proxied paths", async () => {
    const primary = page({ axToken: "dash-tok" })
    await primary.fetch("/api/agents").catch(() => {})
    expect(primary.sent[0].headers.get("Authorization")).toBeNull()
    expect(primary.sent[0].headers.get("X-Agentx-Peer")).toBeNull()
    const other = page({ peer: peerUrl, axToken: "dash-tok" })
    await other.fetch("/api/node/build").catch(() => {})
    expect(other.sent[0].headers.get("Authorization")).toBeNull()
  })

  it("still answers 401 to a proxied call without any token", async () => {
    const p = page({ peer: peerUrl })
    expect((await p.fetch("/api/agents")).status).toBe(401)
  })
})
