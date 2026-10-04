// ObservationPack (#621): keep large tool results out of the conversation.
//
// A tool result stays in a session's context and is re-read on every later
// request. Most of a 40 KB build log is never looked at again. The pack
// answers Claude Code's PostToolUse hook: a text result over the size limit
// is written to disk in full and the model is given its first and last bytes
// plus the path of the file, which it can Read or grep for the exact original.
//
// Claude Code does the same on its own for Bash output over 30,000 characters
// (a 2 KB preview and a saved file); those results are left to it. The pack
// covers what is between its limit and that one, and the tools Claude Code
// does not preview.
//
// The hook replaces the result before the model sees it for the first time.
// The paper this follows (arXiv 2609.20519) shows the full result for two
// requests first; a hook cannot do that, because it runs once per tool call.
//
// Nothing here calls a model, and a result is never dropped: if the original
// cannot be written, the result is left as it was.

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { resolve, sep } from "path"

export interface ObservationPackConfig {
  enabled: boolean
  /** A text result larger than this many bytes is packed. */
  limitBytes: number
  /** Bytes of the start of the original shown to the model. */
  headBytes: number
  /** Bytes of the end of the original shown to the model. */
  tailBytes: number
  /** Tool names the pack applies to. Each entry is a regular expression that
   *  must match the whole name, as in a Claude Code hook matcher. */
  tools: string[]
  /** Days an original is kept on disk. 0 keeps every original. */
  retentionDays: number
}

/** The part of Claude Code's PostToolUse payload the pack reads. */
export interface PostToolUsePayload {
  session_id?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: unknown
}

export interface PackRecord {
  sha: string
  path: string
  bytes: number
  keptBytes: number
}

/** Path marker that tells one of our hook entries from anybody else's. */
export const OBSERVATION_PACK_ROUTE = "/observation/pack"

export function observationDir(root: string = process.cwd()): string {
  return resolve(root, ".agentx/observations")
}

export function toolIsPacked(toolName: string, tools: string[]): boolean {
  return tools.some((pattern) => {
    try {
      return new RegExp(`^(?:${pattern})$`).test(toolName)
    } catch {
      return pattern === toolName
    }
  })
}

/** Cut on a byte count without leaving half a character at the cut. */
function decodeSlice(buf: Buffer, start: number, end: number): string {
  return buf.subarray(start, end).toString("utf-8").replace(/^�+|�+$/g, "")
}

/** The text the model gets in place of `text`. */
export function buildExcerpt(text: string, path: string, config: Pick<ObservationPackConfig, "headBytes" | "tailBytes">): string {
  const buf = Buffer.from(text, "utf-8")
  const head = decodeSlice(buf, 0, config.headBytes)
  const tail = config.tailBytes > 0 ? decodeSlice(buf, buf.length - config.tailBytes, buf.length) : ""
  const withheld = buf.length - config.headBytes - config.tailBytes
  const lines = text.split("\n").length
  return [
    `[ObservationPack: this result is ${buf.length} bytes (${lines} lines). Only its first ${config.headBytes} and last ${config.tailBytes} bytes are shown.`,
    `The exact original is saved at ${path}`,
    `Read that file with offset and limit (line numbers), or grep it, for the part you need. Do not guess at what is not shown.]`,
    head,
    `[... ${withheld} bytes not shown ...]`,
    tail,
  ].join("\n")
}

/** Write the original where the model can read it back. Same text, same file. */
function storeOriginal(dir: string, text: string): { sha: string; path: string } {
  const sha = createHash("sha256").update(text).digest("hex")
  const path = resolve(dir, `${sha}.txt`)
  if (existsSync(path)) {
    // Seen again: keep it clear of the retention sweep.
    const now = new Date()
    utimesSync(path, now, now)
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(path, text, { mode: 0o600 })
  }
  return { sha, path }
}

/**
 * Pack one tool result. Returns the replacement for `tool_response`, in the
 * tool's own shape, and one record per packed text; or null when nothing is
 * to change (pack off, tool not listed, nothing over the limit, an image, a
 * result Claude Code already saved to a file, or a read of an original we
 * saved ourselves).
 */
export function packToolOutput(
  payload: PostToolUsePayload,
  config: ObservationPackConfig,
  dir: string,
): { updated: unknown; packs: PackRecord[] } | null {
  if (!config.enabled) return null
  const tool = payload.tool_name
  if (!tool || !toolIsPacked(tool, config.tools)) return null

  // Reading a saved original back must return it whole, or it could never be
  // retrieved.
  const filePath = payload.tool_input?.["file_path"]
  if (typeof filePath === "string" && resolve(filePath).startsWith(dir + sep)) return null

  // An excerpt has to be smaller than what it replaces.
  if (config.limitBytes <= config.headBytes + config.tailBytes) return null

  const packs: PackRecord[] = []
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value, "utf-8")
      if (bytes <= config.limitBytes) return value
      const { sha, path } = storeOriginal(dir, value)
      const excerpt = buildExcerpt(value, path, config)
      packs.push({ sha, path, bytes, keptBytes: Buffer.byteLength(excerpt, "utf-8") })
      return excerpt
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>
      // Pictures are not text; base64 cut in the middle is noise.
      if (obj["type"] === "image" || obj["isImage"] === true) return value
      // Claude Code already saved this one to a file and shows a preview
      // (Bash output over 30,000 characters). What we get here is cut short,
      // so it is not the original; leave its own handle in place.
      if (typeof obj["persistedOutputPath"] === "string") return value
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, walk(v)]))
    }
    return value
  }

  try {
    const updated = walk(payload.tool_response)
    return packs.length > 0 ? { updated, packs } : null
  } catch {
    // Could not save an original: the model keeps the full result.
    return null
  }
}

/**
 * Answer a PostToolUse hook call. Returns the JSON Claude Code expects on the
 * hook's stdout, or "" to leave the result alone. Each pack is appended to
 * `index.jsonl` in the store, so what was withheld can be counted later.
 */
export function answerPackHook(
  payload: PostToolUsePayload,
  config: ObservationPackConfig,
  opts: { dir: string; agentId?: string },
): string {
  const result = packToolOutput(payload, config, opts.dir)
  if (!result) return ""
  try {
    const at = new Date().toISOString()
    const rows = result.packs.map((p) =>
      JSON.stringify({ at, agent: opts.agentId, session: payload.session_id, tool: payload.tool_name, sha: p.sha, bytes: p.bytes, keptBytes: p.keptBytes }),
    )
    appendFileSync(resolve(opts.dir, "index.jsonl"), rows.join("\n") + "\n", { mode: 0o600 })
  } catch {
    // The index is a count, not the evidence. The original is already saved.
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: result.updated },
  })
}

/** Delete originals not written or seen again for `retentionDays`. Returns how many. */
export function pruneObservations(dir: string, retentionDays: number, now: number = Date.now()): number {
  if (retentionDays <= 0 || !existsSync(dir)) return 0
  const cutoff = now - retentionDays * 86_400_000
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue
    const path = resolve(dir, name)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path)
        removed++
      }
    } catch {
      // Gone or unreadable: nothing to prune.
    }
  }
  return removed
}
