import { afterEach, describe, expect, it } from "vitest"
import { createServer, request, type Server, type ServerResponse } from "http"
import { brotliDecompressSync, gunzipSync } from "zlib"
import type { AddressInfo } from "net"
import { compressResponse, MIN_COMPRESS_BYTES, pickEncoding } from "../src/daemon/http-compress"

const BIG = "<p>agentx dashboard</p>".repeat(200)

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

function serve(handler: (res: ServerResponse) => void): Promise<number> {
  server = createServer((req, res) => {
    compressResponse(req, res)
    handler(res)
  })
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as AddressInfo).port)))
}

function get(port: number, acceptEncoding?: string, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, any>; body: Buffer }>((resolve, reject) => {
    const req = request({ port, host: "127.0.0.1", method, headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {} }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on("error", reject)
    req.end()
  })
}

describe("pickEncoding", () => {
  it("prefers br, falls back to gzip, honours q=0", () => {
    expect(pickEncoding("gzip, deflate, br")).toBe("br")
    expect(pickEncoding("gzip, deflate")).toBe("gzip")
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip")
    expect(pickEncoding("identity")).toBeNull()
    expect(pickEncoding(undefined)).toBeNull()
  })
})

describe("compressResponse", () => {
  it("brotli-compresses a page sent with writeHead + end", async () => {
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end(BIG)
    })
    const r = await get(port, "gzip, br")
    expect(r.headers["content-encoding"]).toBe("br")
    expect(r.headers.vary).toBe("Accept-Encoding")
    expect(r.body.length).toBeLessThan(BIG.length / 5)
    expect(brotliDecompressSync(r.body).toString()).toBe(BIG)
  })

  it("gzips JSON when the client only takes gzip, keeping status and headers", async () => {
    const json = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ i, name: "card" })) })
    const port = await serve((res) => {
      res.setHeader("Cache-Control", "no-store")
      res.writeHead(201, "Made", { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) })
      res.end(json)
    })
    const r = await get(port, "gzip")
    expect(r.status).toBe(201)
    expect(r.headers["content-encoding"]).toBe("gzip")
    expect(r.headers["content-length"]).toBeUndefined()
    expect(r.headers["cache-control"]).toBe("no-store")
    expect(JSON.parse(gunzipSync(r.body).toString())).toEqual(JSON.parse(json))
  })

  it("compresses a body ended without writeHead", async () => {
    const port = await serve((res) => {
      res.setHeader("Content-Type", "application/javascript")
      res.end(Buffer.from(BIG))
    })
    const r = await get(port, "gzip")
    expect(r.headers["content-encoding"]).toBe("gzip")
    expect(gunzipSync(r.body).toString()).toBe(BIG)
  })

  it("leaves small bodies, images, HEAD and clients without Accept-Encoding alone", async () => {
    const small = "x".repeat(MIN_COMPRESS_BYTES - 1)
    let body = small
    let type = "text/plain"
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": type })
      res.end(body)
    })
    expect((await get(port, "br")).headers["content-encoding"]).toBeUndefined()
    body = BIG
    type = "image/png"
    expect((await get(port, "br")).headers["content-encoding"]).toBeUndefined()
    type = "text/html"
    const plain = await get(port)
    expect(plain.headers["content-encoding"]).toBeUndefined()
    expect(plain.body.toString()).toBe(BIG)
    expect((await get(port, "br", "HEAD")).headers["content-encoding"]).toBeUndefined()
  })

  it("passes streams (SSE, write-then-end) through uncompressed", async () => {
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.flushHeaders()
      res.write(`data: ${BIG}\n\n`)
      res.end()
    })
    const r = await get(port, "br")
    expect(r.headers["content-encoding"]).toBeUndefined()
    expect(r.body.toString()).toBe(`data: ${BIG}\n\n`)

    await new Promise<void>((done) => server!.close(() => done()))
    const port2 = await serve((res) => {
      res.writeHead(200, { "Content-Type": "text/html" })
      res.write(BIG)
      res.end(BIG)
    })
    const r2 = await get(port2, "br")
    expect(r2.headers["content-encoding"]).toBeUndefined()
    expect(r2.body.toString()).toBe(BIG + BIG)
  })

  it("does not re-encode a body that already has Content-Encoding", async () => {
    const port = await serve((res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "identity" })
      res.end(BIG)
    })
    const r = await get(port, "br")
    expect(r.headers["content-encoding"]).toBe("identity")
    expect(r.body.toString()).toBe(BIG)
  })
})
