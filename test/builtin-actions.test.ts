import { describe, it, expect, beforeEach } from "vitest"
import { createServer, type Server } from "http"
import { z } from "zod"
import {
  registerAllBuiltins,
  listBuiltins,
  getBuiltin,
  runBuiltin,
  _resetBuiltinsForTesting,
} from "../src/actions/builtin"
import { registerBuiltin } from "../src/actions/builtin/registry"
import type { BuiltinAction } from "../src/actions/builtin/types"

beforeEach(() => {
  _resetBuiltinsForTesting()
})

describe("registerBuiltin", () => {
  it("rejects malformed names", () => {
    const dummy: BuiltinAction = {
      name: "Bad-Name",
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async () => ({}),
    }
    expect(() => registerBuiltin(dummy)).toThrow(/dotted lowercase/)
    expect(() => registerBuiltin({ ...dummy, name: "" })).toThrow(/dotted lowercase/)
    expect(() => registerBuiltin({ ...dummy, name: "1foo" })).toThrow(/dotted lowercase/)
  })

  it("accepts dotted lowercase identifiers", () => {
    const a: BuiltinAction = {
      name: "foo.bar_baz",
      description: "x",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async () => ({}),
    }
    expect(() => registerBuiltin(a)).not.toThrow()
    expect(getBuiltin("foo.bar_baz")?.name).toBe("foo.bar_baz")
  })

  it("idempotent on re-register", () => {
    const a: BuiltinAction = {
      name: "x.y",
      description: "v1",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: async () => ({}),
    }
    registerBuiltin(a)
    registerBuiltin({ ...a, description: "v2" })
    expect(getBuiltin("x.y")?.description).toBe("v2")
  })
})

describe("listBuiltins", () => {
  it("returns metadata sorted by name", () => {
    registerAllBuiltins()
    const list = listBuiltins()
    expect(list.length).toBeGreaterThanOrEqual(2)
    const names = list.map((a) => a.name)
    expect([...names].sort()).toEqual(names)
    expect(names).toContain("http.fetch")
    expect(names).toContain("http.post")
    for (const m of list) {
      expect(m.description.length).toBeGreaterThan(0)
    }
  })
})

describe("runBuiltin", () => {
  it("validates input and rejects bad shapes", async () => {
    registerAllBuiltins()
    await expect(runBuiltin("http.fetch", { url: 123 })).rejects.toThrow()
  })

  it("rejects unknown action name", async () => {
    registerAllBuiltins()
    await expect(runBuiltin("nope.nada", {})).rejects.toThrow(/unknown built-in/)
  })

  it("enforces per-action timeout", async () => {
    registerBuiltin({
      name: "slow.thing",
      description: "test",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      timeoutMs: 50,
      handler: async () => new Promise(() => { /* never resolves */ }),
    } as BuiltinAction)
    await expect(runBuiltin("slow.thing", {})).rejects.toThrow(/timed out after 50ms/)
  })

  it("logs but doesn't throw on output schema mismatch", async () => {
    const errs: string[] = []
    const origWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: any) => { errs.push(String(c)); return true }) as any
    try {
      registerBuiltin({
        name: "drift.test",
        description: "test",
        inputSchema: z.object({}),
        outputSchema: z.object({ count: z.number() }),
        handler: async () => ({ wrong: "shape" }) as any,
      } as BuiltinAction)
      const out = await runBuiltin("drift.test", {})
      expect(out).toEqual({ wrong: "shape" }) // value passed through
      expect(errs.some((e) => e.includes("drift.test") && e.includes("schema validation"))).toBe(true)
    } finally {
      process.stderr.write = origWrite
    }
  })
})

// --- HTTP built-in integration tests ---

async function withServer(handler: (req: any, res: any) => void, fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : 0
  try { await fn(port) } finally { await new Promise<void>((r) => server.close(() => r())) }
}

describe("http.fetch", () => {
  it("GETs a URL and returns body + status + headers", async () => {
    registerAllBuiltins()
    await withServer(
      (req, res) => {
        res.writeHead(200, { "content-type": "text/plain", "x-test": "ok" })
        res.end("hello world")
      },
      async (port) => {
        const out: any = await runBuiltin("http.fetch", { url: `http://127.0.0.1:${port}/` })
        expect(out.status).toBe(200)
        expect(out.body).toBe("hello world")
        expect(out.headers["content-type"]).toContain("text/plain")
        expect(out.headers["x-test"]).toBe("ok")
        expect(out.truncated).toBe(false)
      },
    )
  })

  it("rejects non-http schemes", async () => {
    registerAllBuiltins()
    await expect(runBuiltin("http.fetch", { url: "file:///etc/passwd" })).rejects.toThrow(/scheme not allowed/)
  })

  it("returns the response status verbatim — does not throw on 4xx/5xx", async () => {
    registerAllBuiltins()
    await withServer(
      (_req, res) => { res.writeHead(404, { "content-type": "text/plain" }); res.end("nope") },
      async (port) => {
        const out: any = await runBuiltin("http.fetch", { url: `http://127.0.0.1:${port}/` })
        expect(out.status).toBe(404)
        expect(out.body).toBe("nope")
      },
    )
  })

  it("forwards headers", async () => {
    registerAllBuiltins()
    let received: string | undefined
    await withServer(
      (req, res) => { received = req.headers["x-auth"] as string; res.writeHead(200); res.end("ok") },
      async (port) => {
        await runBuiltin("http.fetch", { url: `http://127.0.0.1:${port}/`, headers: { "X-Auth": "secret" } })
        expect(received).toBe("secret")
      },
    )
  })

  it("truncates oversized bodies and reports truncated=true", async () => {
    registerAllBuiltins()
    const big = "x".repeat(2 * 1024 * 1024) // 2MB > 1MB cap
    await withServer(
      (_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(big) },
      async (port) => {
        const out: any = await runBuiltin("http.fetch", { url: `http://127.0.0.1:${port}/` })
        expect(out.truncated).toBe(true)
        expect(out.body.length).toBeLessThanOrEqual(1024 * 1024 + 100) // tolerance for boundary
      },
    )
  })
})

describe("http.post", () => {
  it("POSTs JSON body and returns response", async () => {
    registerAllBuiltins()
    let receivedBody = ""
    let receivedCT: string | undefined
    await withServer(
      (req, res) => {
        receivedCT = req.headers["content-type"] as string
        let buf = ""
        req.on("data", (c: Buffer) => (buf += c.toString()))
        req.on("end", () => {
          receivedBody = buf
          res.writeHead(201, { "content-type": "application/json" })
          res.end(JSON.stringify({ created: true, echo: JSON.parse(buf) }))
        })
      },
      async (port) => {
        const out: any = await runBuiltin("http.post", {
          url: `http://127.0.0.1:${port}/`,
          body: { name: "alice", count: 3 },
        })
        expect(out.status).toBe(201)
        expect(receivedCT).toContain("application/json")
        expect(JSON.parse(receivedBody)).toEqual({ name: "alice", count: 3 })
        expect(JSON.parse(out.body).created).toBe(true)
      },
    )
  })

  it("rejects non-http schemes", async () => {
    registerAllBuiltins()
    await expect(runBuiltin("http.post", { url: "ftp://example.com", body: {} })).rejects.toThrow(/scheme not allowed/)
  })
})
