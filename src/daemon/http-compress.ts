/**
 * Response compression for the dashboard server (`board serve`).
 *
 * The dashboard is opened over Tailscale from the Mac, whose upload is slow
 * (~160 KB/s): the 800 KB home page took ~5 s raw and ~1 s with brotli.
 * Only a response sent whole with one `end(body)` is compressed. A response
 * that calls `write()` (SSE, piped files, any stream) goes out untouched,
 * so nothing that streams is ever held back.
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http"
import { brotliCompress, constants, gzip } from "zlib"
import { promisify } from "util"

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

/** Bodies smaller than this are sent as they are. */
export const MIN_COMPRESS_BYTES = 1024

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|application\/[\w.+-]+\+json|image\/svg\+xml)/i

function compressibleType(type: unknown): boolean {
  const t = String(type ?? "")
  return COMPRESSIBLE.test(t) && !/^text\/event-stream/i.test(t)
}

/** "br" when the client accepts it, else "gzip", else null (identity). */
export function pickEncoding(header: string | string[] | undefined): "br" | "gzip" | null {
  const accepted = new Map<string, number>()
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";")
    if (!name) continue
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="))
    accepted.set(name, q ? Number(q.slice(2)) || 0 : 1)
  }
  const ok = (enc: string) => (accepted.get(enc) ?? accepted.get("*") ?? 0) > 0
  if (ok("br")) return "br"
  if (ok("gzip")) return "gzip"
  return null
}

function addVary(res: ServerResponse): void {
  const vary = String(res.getHeader("Vary") ?? "")
  if (!/accept-encoding|\*/i.test(vary)) res.setHeader("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding")
}

/**
 * Patches `res` so a whole-body text/JSON/JS/CSS/SVG response is sent with
 * br or gzip. Call once, before any route writes to `res`.
 */
export function compressResponses(req: IncomingMessage, res: ServerResponse): void {
  const method = (req.method || "GET").toUpperCase()
  const encoding = pickEncoding(req.headers["accept-encoding"])
  const origWriteHead = res.writeHead
  const origWrite = res.write
  const origEnd = res.end
  const restore = () => { res.writeHead = origWriteHead; res.write = origWrite; res.end = origEnd }

  // writeHead is held back (its headers become setHeader calls) so end() can
  // still add Content-Encoding. Node sends them on the first write or end.
  res.writeHead = function (this: ServerResponse, status: number, ...rest: any[]) {
    const statusMessage = typeof rest[0] === "string" ? rest[0] : undefined
    const headers = (typeof rest[0] === "string" ? rest[1] : rest[0]) as OutgoingHttpHeaders | undefined
    const type = Array.isArray(headers) ? undefined
      : Object.entries(headers ?? {}).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? res.getHeader("Content-Type")
    if (Array.isArray(headers) || !compressibleType(type)) {
      restore()
      return origWriteHead.apply(this, [status, ...rest] as any)
    }
    for (const [k, v] of Object.entries(headers ?? {})) if (v !== undefined) res.setHeader(k, v)
    res.statusCode = status
    if (statusMessage) res.statusMessage = statusMessage
    return res
  } as typeof res.writeHead

  res.write = function (this: ServerResponse, ...args: any[]) {
    restore()
    return origWrite.apply(this, args as any)
  } as typeof res.write

  res.end = function (this: ServerResponse, ...args: any[]) {
    restore()
    const cb = typeof args[args.length - 1] === "function" ? args.pop() : undefined
    const [chunk, enc] = args
    const passThrough = () => origEnd.apply(this, [...args, ...(cb ? [cb] : [])] as any)
    if (chunk == null || typeof chunk === "function" || res.headersSent) return passThrough()
    if (!compressibleType(res.getHeader("Content-Type"))) return passThrough()
    addVary(res)
    const body = typeof chunk === "string" ? Buffer.from(chunk, enc as BufferEncoding | undefined) : Buffer.from(chunk as Uint8Array)
    if (!encoding || method === "HEAD" || body.length < MIN_COMPRESS_BYTES
      || res.statusCode === 204 || res.statusCode === 304 || res.getHeader("Content-Encoding")) {
      return passThrough()
    }
    const squeeze = encoding === "br"
      // Quality 5: close to max ratio on HTML/JSON at a fraction of the CPU.
      ? brotliAsync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : gzipAsync(body, { level: 6 })
    squeeze.then(
      (out) => {
        if (res.headersSent || res.destroyed) return
        res.setHeader("Content-Encoding", encoding)
        res.setHeader("Content-Length", out.length)
        origEnd.call(res, out, cb)
      },
      () => { if (!res.headersSent && !res.destroyed) origEnd.call(res, body, cb) },
    )
    return res
  } as typeof res.end
}
