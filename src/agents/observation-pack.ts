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
// A file read (the Read tool) is packed too, since the owner's decision of
// 2026-10-05 on #621. The file is its own original, so nothing is copied:
// the model keeps the first and last lines, with the file's path and the
// line numbers of what was left out, and reads those again with offset and
// limit when it needs them.
//
// The hook replaces the result before the model sees it for the first time.
// The paper this follows (arXiv 2609.20519) shows the full result for two
// requests first; a hook cannot do that, because it runs once per tool call.
//
// Nothing here calls a model, and a result is never dropped: if the original
// cannot be written, the result is left as it was.

import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs"
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

/** The store: one folder per agent under it. */
export function observationDir(root: string = process.cwd()): string {
  return resolve(root, ".agentx/observations")
}

/**
 * One agent's folder in the store. An agent is allowed to read its own
 * folder only: an original holds whatever its command printed. The id is
 * encoded so that no id can name a folder outside the store.
 */
export function agentObservationDir(storeDir: string, agentId: string): string {
  return resolve(storeDir, encodeURIComponent(agentId).replace(/\./g, "%2E"))
}

/**
 * Whether an agent can read a saved original back. Seen live on Claude Code
 * 2.1.289: outside `bypassPermissions` the Read of an original is refused in
 * a session nobody answers for, the allow rule notwithstanding, and the model
 * then guesses at the part it was not shown. Such an agent is not packed.
 */
export function canReadOriginals(permissionMode: string | undefined): boolean {
  return permissionMode === "bypassPermissions"
}

/** The same path with symlinks followed, or as given when it does not exist. */
function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
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

/** Average line size above which the excerpt points at byte ranges, not lines. */
const LONG_LINE_BYTES = 2000

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
  // A line read or a grep match on very long lines (minified JSON) returns
  // as much as the original, which is then packed again.
  const longLines = buf.length / lines > LONG_LINE_BYTES
  const how = longLines
    ? `Its lines are very long, so read it by byte range (for example head -c or tail -c, or jq for JSON) for the part you need.`
    : `Read that file with offset and limit (line numbers), or grep it, for the part you need. Do not cat it whole: that is packed again.`
  return [
    `[ObservationPack: this result is ${buf.length} bytes (${lines} lines). Only its first ${config.headBytes} and last ${config.tailBytes} bytes are shown.`,
    `The exact original is saved at ${path}`,
    `${how} Do not guess at what is not shown.]`,
    head,
    `[... ${withheld} bytes not shown ...]`,
    tail,
  ].join("\n")
}

/** The text shape of a Read result in Claude Code's PostToolUse payload. */
interface ReadTextResult {
  type: "text"
  file: { filePath?: string; content: string; numLines?: number; startLine?: number; totalLines?: number }
}

function isReadTextResult(value: unknown): value is ReadTextResult {
  const obj = value as Partial<ReadTextResult> | null
  return !!obj && typeof obj === "object" && obj.type === "text" && typeof obj.file?.content === "string"
}

/** How many lines `text` spans, counting a final unterminated line. */
function lineCount(text: string): number {
  if (text === "") return 0
  let n = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++
  if (text.endsWith("\n")) n--
  return n
}

/**
 * The text the model gets in place of a file read. The file itself is the
 * original, so nothing is copied: the excerpt keeps whole lines from both
 * ends and names the file and the exact line numbers of what is not shown,
 * so the model asks for the part it needs with offset and limit.
 *
 * Claude Code prints its line numbers beside the content it is given, from
 * `startLine` on. The head comes first and ends on a line break, so its
 * numbers are the file's; the notice and the tail that follow are numbered
 * on from there, so the notice states the tail's real first line.
 */
export function buildReadExcerpt(
  content: string,
  file: { path: string; startLine: number; totalLines?: number },
  config: Pick<ObservationPackConfig, "headBytes" | "tailBytes">,
): string {
  const buf = Buffer.from(content, "utf-8")
  const lines = lineCount(content)

  // Whole lines within the budget. A line longer than the budget is cut,
  // and then counts as not shown, since part of it is not.
  let head = decodeSlice(buf, 0, config.headBytes)
  const headBreak = head.lastIndexOf("\n")
  head = headBreak === -1 ? head : head.slice(0, headBreak + 1)
  let tail = config.tailBytes > 0 ? decodeSlice(buf, buf.length - config.tailBytes, buf.length) : ""
  const tailBreak = tail.indexOf("\n")
  tail = tailBreak === -1 ? tail : tail.slice(tailBreak + 1)

  const headLines = headBreak === -1 ? 0 : lineCount(head)
  const tailLines = tailBreak === -1 ? 0 : lineCount(tail)
  const first = file.startLine
  const last = first + lines - 1
  const hiddenFrom = first + headLines
  const hiddenTo = last - tailLines
  const withheld = buf.length - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8")
  const whole = typeof file.totalLines === "number" && file.totalLines > lines ? ` (${file.totalLines} lines in all)` : ""
  const hidden = hiddenFrom === hiddenTo ? `Line ${hiddenFrom} (${withheld} bytes) is` : `Lines ${hiddenFrom} to ${hiddenTo} (${withheld} bytes) are`
  const cut = [headLines === 0 && head !== "" ? first : null, tailLines === 0 && tail !== "" ? last : null].filter((n) => n !== null)
  const partly = cut.length === 0 ? "" : cut.length === 1 || cut[0] === cut[1] ? ` (line ${cut[0]} only in part)` : ` (lines ${cut[0]} and ${cut[1]} only in part)`
  const tailNote = tailLines > 0 ? ` Lines ${hiddenTo + 1} to ${last} follow; the numbers beside them are not the file's.` : ""

  return [
    head,
    `[ObservationPack: this read is ${buf.length} bytes, lines ${first} to ${last} of ${file.path}${whole}.`,
    `${hidden} not shown${partly}.${tailNote}`,
    `Read the file again with offset and limit for the lines you need, or Grep it. Do not guess at what is not shown.]`,
    tail,
  ]
    .filter((part) => part !== "")
    .join("\n")
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
 * to change (pack off, tool not listed, nothing over the limit, a picture,
 * sound or other base64 item, a result Claude Code already saved to a file,
 * or a read of an original we saved ourselves). For a file read the record's
 * `path` is the file itself.
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
  if (typeof filePath === "string" && realPath(filePath).startsWith(realPath(dir) + sep)) return null

  // An excerpt has to be smaller than what it replaces.
  if (config.limitBytes <= config.headBytes + config.tailBytes) return null

  // A file read: the file is the original, so none is copied. Only the text
  // shape is cut; a notebook, a PDF or a picture is left whole.
  if (tool === "Read") {
    const response = payload.tool_response
    if (!isReadTextResult(response)) return null
    const content = response.file.content
    const bytes = Buffer.byteLength(content, "utf-8")
    if (bytes <= config.limitBytes) return null
    const path = typeof filePath === "string" ? filePath : (response.file.filePath ?? "the file you read")
    const offset = payload.tool_input?.["offset"]
    const startLine =
      typeof response.file.startLine === "number" && response.file.startLine >= 1
        ? response.file.startLine
        : typeof offset === "number" && offset >= 1
          ? offset
          : 1
    const excerpt = buildReadExcerpt(content, { path, startLine, totalLines: response.file.totalLines }, config)
    const sha = createHash("sha256").update(content).digest("hex")
    return {
      updated: { ...response, file: { ...response.file, content: excerpt } },
      packs: [{ sha, path, bytes, keptBytes: Buffer.byteLength(excerpt, "utf-8") }],
    }
  }

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
      // Pictures and sound are not text; base64 cut in the middle is noise.
      if (obj["type"] === "image" || obj["type"] === "audio" || obj["isImage"] === true) return value
      // Claude Code already saved this one to a file and shows a preview
      // (Bash output over 30,000 characters). What we get here is cut short,
      // so it is not the original; leave its own handle in place.
      if (typeof obj["persistedOutputPath"] === "string") return value
      // `blob` is the base64 body of an MCP resource; its `text` twin is packed.
      return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, k === "blob" ? v : walk(v)]))
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
 * hook's stdout, or "" to leave the result alone. `dir` is the calling
 * agent's own folder. Each pack is appended to `index.jsonl` there, so what
 * was withheld can be counted later.
 */
export function answerPackHook(
  payload: PostToolUsePayload,
  config: ObservationPackConfig,
  opts: { dir: string; agentId?: string },
): string {
  // A body that is not an object (JSON `null`) is no tool result.
  const result = payload && typeof payload === "object" ? packToolOutput(payload, config, opts.dir) : null
  if (!result) return ""
  try {
    const at = new Date().toISOString()
    const rows = result.packs.map((p) =>
      JSON.stringify({ at, agent: opts.agentId, session: payload.session_id, tool: payload.tool_name, sha: p.sha, bytes: p.bytes, keptBytes: p.keptBytes }),
    )
    // A packed file read copies nothing, so the folder may not exist yet.
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
    appendFileSync(resolve(opts.dir, "index.jsonl"), rows.join("\n") + "\n", { mode: 0o600 })
  } catch {
    // The index is a count, not the evidence. The original is already saved.
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: result.updated },
  })
}

/**
 * Delete originals not written or seen again for `retentionDays`, in every
 * agent's folder of the store. Returns how many.
 */
export function pruneObservations(storeDir: string, retentionDays: number, now: number = Date.now()): number {
  if (retentionDays <= 0 || !existsSync(storeDir)) return 0
  const cutoff = now - retentionDays * 86_400_000
  let removed = 0
  for (const agent of readdirSync(storeDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue
    const dir = resolve(storeDir, agent.name)
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
  }
  return removed
}
