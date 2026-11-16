import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createServer, get, type IncomingMessage, type Server } from "http"
import type { AddressInfo } from "net"
import { brotliDecompressSync, gunzipSync } from "zlib"
import { compressResponses, pickEncoding } from "../src/daemon/http-compress"

const PAGE = "<!doctype html><title>x</title>" + "<p>dashboard row</p>".repeat(500)

let server: Server
let base: string

beforeAll(async () => {
  server = createServer((req, res) => {
    compressResponses(req, res)
    if (req.url === "/") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE); return }
    if (req.url === "/api/app/x") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ rows: PAGE })); return }
    if (req.url === "/small") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return }
    if (req.url === "/icon.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(Buffer.alloc(4096)); return }
    if (req.url === "/sse") {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.write("event: hello\ndata: 1\n\n")
      return // left open, like a live feed
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => { server.closeAllConnections(); server.close() })

function fetchRaw(path: string, acceptEncoding?: string): Promise<{ res: IncomingMessage; body: Buffer }> {
  return new Promise((resolve, reject) => {
    get(base + path, { headers: acceptEncoding ? { "Accept-Encoding": acceptEncoding } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks) }))
    }).on("error", reject)
  })
}

describe("dashboard response compression", () => {
  it("sends br when the client accepts it", async () => {
    const { res, body } = await fetchRaw("/", "gzip, deflate, br")
    expect(res.headers["content-encoding"]).toBe("br")
    expect(res.headers["vary"]).toMatch(/Accept-Encoding/)
    expect(Number(res.headers["content-length"])).toBe(body.length)
    expect(body.length).toBeLessThan(PAGE.length / 4)
    expect(brotliDecompressSync(body).toString()).toBe(PAGE)
  })

  it("sends gzip when br is not accepted, also for setHeader-only JSON", async () => {
    const { res, body } = await fetchRaw("/api/app/x", "gzip")
    expect(res.headers["content-encoding"]).toBe("gzip")
    expect(JSON.parse(gunzipSync(body).toString())).toEqual({ rows: PAGE })
  })

  it("sends identity without Accept-Encoding or with br;q=0, gzip;q=0", async () => {
    for (const ae of [undefined, "br;q=0, gzip;q=0"]) {
      const { res, body } = await fetchRaw("/", ae)
      expect(res.headers["content-encoding"]).toBeUndefined()
      expect(res.headers["vary"]).toMatch(/Accept-Encoding/)
      expect(body.toString()).toBe(PAGE)
    }
  })

  it("leaves small bodies and images alone", async () => {
    const small = await fetchRaw("/small", "br")
    expect(small.res.headers["content-encoding"]).toBeUndefined()
    expect(small.body.toString()).toBe("{}")
    const png = await fetchRaw("/icon.png", "br")
    expect(png.res.headers["content-encoding"]).toBeUndefined()
    expect(png.body.length).toBe(4096)
  })

  it("does not buffer SSE: the first event arrives while the stream stays open", async () => {
    const first = await new Promise<{ res: IncomingMessage; chunk: string }>((resolve, reject) => {
      const req = get(base + "/sse", { headers: { "Accept-Encoding": "br, gzip" } }, (res) => {
        res.once("data", (c) => { resolve({ res, chunk: c.toString() }); req.destroy() })
      })
      req.on("error", () => { /* destroyed on purpose */ })
      setTimeout(() => reject(new Error("SSE event was held back")), 2000)
    })
    expect(first.res.headers["content-encoding"]).toBeUndefined()
    expect(first.chunk).toContain("event: hello")
  })

  it("picks br over gzip and honours q=0", () => {
    expect(pickEncoding("gzip, br")).toBe("br")
    expect(pickEncoding("gzip, br;q=0")).toBe("gzip")
    expect(pickEncoding("*")).toBe("br")
    expect(pickEncoding("identity")).toBeNull()
    expect(pickEncoding(undefined)).toBeNull()
  })
})
