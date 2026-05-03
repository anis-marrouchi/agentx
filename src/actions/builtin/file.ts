import { z } from "zod"
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from "fs"
import { resolve, dirname, isAbsolute } from "path"
import type { BuiltinAction } from "./types"

// --- Built-in file actions ---
//
// file.read_lines  — read a text file, return up to maxLines string lines
// file.write_jsonl — append N JSON objects as newline-delimited records
//
// Both are workspace-scoped: paths must resolve under one of the
// allowed roots set via AGENTX_BUILTIN_FILE_ROOTS env var (or the cwd
// by default). This is the boundary that keeps an agent from reading
// /etc/passwd or writing into the daemon's own .agentx state. Path
// traversal (../..) is rejected via the resolved-path containment
// check, not regex on the input.
//
// Why these two specifically (per improvement plan #6 catalog):
//   - read_lines: typed plumbing for "give me the last N log lines"
//     pattern that workflows currently shell out to `tail` for.
//   - write_jsonl: typed plumbing for "log a structured event into
//     this agent's working file" — the workflow-as-program framing
//     wants this as a primitive, not as `echo {} >> file`.

const MAX_FILE_BYTES = 8 * 1024 * 1024 // 8 MB cap on read

/**
 * Resolve and validate a target path against the allowed roots.
 * Returns the absolute path on success; throws otherwise. Allowed
 * roots default to process.cwd() unless the operator overrides via
 * AGENTX_BUILTIN_FILE_ROOTS (colon-separated). This mirrors how
 * Claude Code's own --add-dir flag is applied at spawn.
 */
function resolveAllowed(input: string): string {
  const abs = isAbsolute(input) ? input : resolve(process.cwd(), input)
  const rootsEnv = process.env.AGENTX_BUILTIN_FILE_ROOTS || process.cwd()
  const roots = rootsEnv.split(":").map((r) => resolve(r))
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + "/")) return abs
  }
  throw new Error(`path "${input}" is outside the allowed roots`)
}

const readLinesInput = z.object({
  path: z.string().min(1),
  /** Cap the returned line count. Default 200, hard cap 10000. */
  maxLines: z.number().int().min(1).max(10_000).default(200),
  /** When true, return only the LAST maxLines (tail-style). Default false (head). */
  fromEnd: z.boolean().default(false),
})
type ReadLinesInput = z.infer<typeof readLinesInput>

const readLinesOutput = z.object({
  path: z.string(),
  lines: z.array(z.string()),
  totalLines: z.number().int(),
  truncated: z.boolean(),
})
type ReadLinesOutput = z.infer<typeof readLinesOutput>

export const fileReadLines: BuiltinAction<ReadLinesInput, ReadLinesOutput> = {
  name: "file.read_lines",
  description: "Read a text file as an array of lines (utf-8, 8MB cap, scoped to allowed roots)",
  inputSchema: readLinesInput,
  outputSchema: readLinesOutput,
  timeoutMs: 10_000,
  handler: async (input) => {
    const abs = resolveAllowed(input.path)
    if (!existsSync(abs)) throw new Error(`file not found: ${input.path}`)
    const stat = statSync(abs)
    if (!stat.isFile()) throw new Error(`not a regular file: ${input.path}`)
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`file too large (${stat.size} > ${MAX_FILE_BYTES} bytes)`)
    }
    const content = readFileSync(abs, "utf8")
    // Split on \n but drop a trailing empty token if the file ended in \n —
    // the canonical "logs end with a newline" case.
    const all = content.split("\n")
    if (all.length > 0 && all[all.length - 1] === "") all.pop()
    const totalLines = all.length
    let lines: string[]
    let truncated: boolean
    if (totalLines <= input.maxLines) {
      lines = all
      truncated = false
    } else {
      truncated = true
      lines = input.fromEnd ? all.slice(totalLines - input.maxLines) : all.slice(0, input.maxLines)
    }
    return { path: abs, lines, totalLines, truncated }
  },
}

const writeJsonlInput = z.object({
  path: z.string().min(1),
  /** Records to append, one JSON line each. Each must be a JSON-serializable
   *  value; non-serializable inputs are rejected before any FS write. */
  records: z.array(z.unknown()).min(1),
  /** When true, ensure the parent directory exists (mkdir -p). Default false. */
  createDirs: z.boolean().default(false),
})
type WriteJsonlInput = z.infer<typeof writeJsonlInput>

const writeJsonlOutput = z.object({
  path: z.string(),
  written: z.number().int(),
  bytesAppended: z.number().int(),
})
type WriteJsonlOutput = z.infer<typeof writeJsonlOutput>

export const fileWriteJsonl: BuiltinAction<WriteJsonlInput, WriteJsonlOutput> = {
  name: "file.write_jsonl",
  description: "Append JSON records to a file as newline-delimited JSON (utf-8, scoped to allowed roots)",
  inputSchema: writeJsonlInput,
  outputSchema: writeJsonlOutput,
  timeoutMs: 10_000,
  handler: async (input) => {
    const abs = resolveAllowed(input.path)

    // Pre-serialize EVERYTHING before opening the file so a bad
    // record can't leave a half-written file behind. Each record
    // becomes one JSON line; embedded newlines in strings are
    // escaped naturally by JSON.stringify.
    const lines: string[] = []
    for (const r of input.records) {
      try {
        lines.push(JSON.stringify(r))
      } catch (e: any) {
        throw new Error(`record ${lines.length} not JSON-serializable: ${e?.message || String(e)}`)
      }
    }
    const payload = lines.join("\n") + "\n"

    if (input.createDirs) {
      mkdirSync(dirname(abs), { recursive: true })
    }
    appendFileSync(abs, payload, "utf8")
    return { path: abs, written: lines.length, bytesAppended: Buffer.byteLength(payload, "utf8") }
  },
}
