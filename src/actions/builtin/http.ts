import { z } from "zod"
import type { BuiltinAction } from "./types"

// --- Built-in HTTP actions ---
//
// http.fetch — typed GET, returns body+status+headers
// http.post  — typed POST with JSON body, same response shape
//
// Why bake these in when agents already have Bash + curl: the typed
// shape lets workflows pipe response data into structured downstream
// nodes without parsing curl output. Headers and status are
// first-class. Errors are returned as a result, not thrown — so
// workflow conditional nodes can branch on them.
//
// Body size is capped at 1MB to keep responses bounded; truncate is
// reported back. Allowed schemes are http and https only — file:// /
// data:// / etc. would let an agent read arbitrary local resources
// through this action, which violates the "agents talk over the
// network" boundary.

const MAX_BODY_BYTES = 1024 * 1024 // 1 MB

const HEADER_RECORD = z.record(z.string(), z.string())

const allowedSchemes = ["http:", "https:"] as const

function assertAllowed(url: string): URL {
  let u: URL
  try { u = new URL(url) }
  catch { throw new Error(`invalid url: ${url}`) }
  if (!(allowedSchemes as readonly string[]).includes(u.protocol)) {
    throw new Error(`scheme not allowed (only http/https): ${u.protocol}`)
  }
  return u
}

const fetchInput = z.object({
  url: z.string().min(1),
  headers: HEADER_RECORD.optional(),
  /** Per-call timeout in ms. Default 30s. Capped at the registry's
   *  60s ceiling regardless. */
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
})
type FetchInput = z.infer<typeof fetchInput>

const fetchOutput = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: HEADER_RECORD,
  body: z.string(),
  truncated: z.boolean(),
  url: z.string(),
})
type FetchOutput = z.infer<typeof fetchOutput>

async function readCappedText(res: Response): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: "", truncated: false }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let total = 0
  let body = ""
  let truncated = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > MAX_BODY_BYTES) {
        // Keep what we have, mark truncated, stop reading.
        body += dec.decode(value.slice(0, MAX_BODY_BYTES - (total - value.length)), { stream: false })
        truncated = true
        try { await reader.cancel() } catch { /* */ }
        break
      }
      body += dec.decode(value, { stream: true })
    }
  }
  body += dec.decode()
  return { body, truncated }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((v, k) => { out[k] = v })
  return out
}

export const httpFetch: BuiltinAction<FetchInput, FetchOutput> = {
  name: "http.fetch",
  description: "GET a URL, return body + status + headers (1MB cap, http/https only)",
  inputSchema: fetchInput,
  outputSchema: fetchOutput,
  timeoutMs: 35_000,
  handler: async (input) => {
    assertAllowed(input.url)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), input.timeoutMs)
    try {
      const res = await fetch(input.url, { method: "GET", headers: input.headers ?? {}, signal: ctrl.signal })
      const { body, truncated } = await readCappedText(res)
      return {
        status: res.status,
        statusText: res.statusText,
        headers: headersToObject(res.headers),
        body,
        truncated,
        url: res.url,
      }
    } finally {
      clearTimeout(t)
    }
  },
}

const postInput = z.object({
  url: z.string().min(1),
  /** JSON body, serialized to string at request time. Caller passes
   *  any JSON-serializable value here — strings, objects, arrays. */
  body: z.unknown(),
  headers: HEADER_RECORD.optional(),
  timeoutMs: z.number().int().min(1).max(60_000).default(30_000),
})
type PostInput = z.infer<typeof postInput>

export const httpPost: BuiltinAction<PostInput, FetchOutput> = {
  name: "http.post",
  description: "POST a JSON body to a URL, return body + status + headers (1MB cap, http/https only)",
  inputSchema: postInput,
  outputSchema: fetchOutput,
  timeoutMs: 35_000,
  handler: async (input) => {
    assertAllowed(input.url)
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), input.timeoutMs)
    try {
      const headers = { "Content-Type": "application/json", ...(input.headers ?? {}) }
      const res = await fetch(input.url, {
        method: "POST",
        headers,
        body: JSON.stringify(input.body ?? {}),
        signal: ctrl.signal,
      })
      const { body, truncated } = await readCappedText(res)
      return {
        status: res.status,
        statusText: res.statusText,
        headers: headersToObject(res.headers),
        body,
        truncated,
        url: res.url,
      }
    } finally {
      clearTimeout(t)
    }
  },
}
