import { brotliCompress, constants as zlibConstants, gzip } from "zlib"
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http"

/**
 * Compress dashboard responses with Brotli or gzip.
 *
 * Only responses sent in one piece (`res.end(body)`) are compressed: pages,
 * JSON and static assets, which are nearly all of the bytes a page load
 * moves. Anything that calls `write()` or `flushHeaders()` first (SSE,
 * piped files, range requests) is passed through untouched, so streams keep
 * flushing as they did.
 */

/** Below this, the encoding header costs about what compression saves. */
export const MIN_COMPRESS_BYTES = 1024

const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/i

export type Encoding = "br" | "gzip"

/** Brotli when the client takes it, else gzip, else nothing. q=0 refuses. */
export function pickEncoding(acceptEncoding: string | string[] | undefined): Encoding | null {
  const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : acceptEncoding || ""
  const accepted = new Set<string>()
  for (const part of raw.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";")
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
    if (name && !(q && Number(q.slice(2)) === 0)) accepted.add(name)
  }
  if (accepted.has("br")) return "br"
  if (accepted.has("gzip")) return "gzip"
  return null
}

function compress(body: Buffer, enc: Encoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out))
    if (enc === "br") {
      // Quality 5: most of Brotli's gain at a fraction of the default 11's CPU.
      brotliCompress(body, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
        },
      }, done)
    } else {
      gzip(body, done)
    }
  })
}

function shouldCompress(res: ServerResponse, body: Buffer): boolean {
  const status = res.statusCode
  if (status < 200 || status === 204 || status === 304) return false
  if (body.length < MIN_COMPRESS_BYTES) return false
  if (res.getHeader("content-encoding")) return false
  return COMPRESSIBLE.test(String(res.getHeader("content-type") || ""))
}

/**
 * Wrap `res` so a one-piece response is compressed for this request.
 * Call once per request, before any handler writes to `res`.
 */
export function compressResponse(req: IncomingMessage, res: ServerResponse): void {
  const enc = pickEncoding(req.headers["accept-encoding"])
  if (!enc || req.method === "HEAD") return

  const origWriteHead = res.writeHead
  const origWrite = res.write
  const origEnd = res.end
  const origFlushHeaders = res.flushHeaders
  let pending: any[] | null = null

  const restore = () => {
    res.writeHead = origWriteHead
    res.write = origWrite
    res.end = origEnd
    res.flushHeaders = origFlushHeaders
  }
  // Streaming from here on: send the held headers and step aside.
  const passThrough = () => {
    restore()
    if (pending) origWriteHead.apply(res, pending as any)
    pending = null
  }

  // Headers are held until end() so the encoding headers can still be set.
  res.writeHead = function (...args: any[]) {
    pending = args
    return res
  } as any
  res.write = function (...args: any[]) {
    passThrough()
    return (origWrite as any).apply(res, args)
  } as any
  res.flushHeaders = function () {
    passThrough()
    return origFlushHeaders.call(res)
  }
  res.end = function (chunk?: any, encoding?: any, cb?: any) {
    if (typeof chunk === "function") { cb = chunk; chunk = undefined; encoding = undefined }
    if (typeof encoding === "function") { cb = encoding; encoding = undefined }

    // A raw header array or no body: nothing to gain, send as written.
    const headers = pending ? (typeof pending[1] === "string" ? pending[2] : pending[1]) : undefined
    if (chunk == null || Array.isArray(headers)) {
      passThrough()
      return (origEnd as any).call(res, chunk, encoding, cb)
    }

    restore()
    if (pending) {
      res.statusCode = pending[0]
      if (typeof pending[1] === "string") res.statusMessage = pending[1]
      for (const [k, v] of Object.entries((headers || {}) as OutgoingHttpHeaders)) {
        if (v !== undefined) res.setHeader(k, v)
      }
      pending = null
    }

    const body = Buffer.isBuffer(chunk) ? chunk
      : typeof chunk === "string" ? Buffer.from(chunk, encoding || "utf8")
      : Buffer.from(chunk)
    if (!shouldCompress(res, body)) return origEnd.call(res, body, cb)

    compress(body, enc).then(
      (out) => {
        res.setHeader("Content-Encoding", enc)
        res.setHeader("Vary", appendVary(res.getHeader("vary")))
        res.removeHeader("Content-Length")
        origEnd.call(res, out, cb)
      },
      () => { origEnd.call(res, body, cb) },
    )
    return res
  } as any
}

function appendVary(current: ReturnType<ServerResponse["getHeader"]>): string {
  const v = Array.isArray(current) ? current.join(", ") : current ? String(current) : ""
  if (/(^|,)\s*(accept-encoding|\*)\s*(,|$)/i.test(v)) return v
  return v ? `${v}, Accept-Encoding` : "Accept-Encoding"
}
