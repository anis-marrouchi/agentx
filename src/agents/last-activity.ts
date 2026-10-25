// --- A running task's latest activity, in one short line (#1381) ---
//
// The Wall's Live page shows, for each session and job running now, what
// it did last. That is the last complete event in the task's output, which
// the registry already buffers for the task page's stream. The stream
// marks each event with a sigil (see TaskOutput in registry.ts):
//   "· "  system line        "→ "  tool call: Name(args)
//   "← "  tool result        "💭 " internal reasoning
//   "[error] "  an error      anything else: the reply being written
//
// Bounded on purpose: a list API returns a summary, never the transcript.
// A tool call keeps its name and drops its arguments; a result keeps only
// whether it failed.

/** How much of a line the list keeps. */
export const LAST_ACTIVITY_MAX = 140
/** Only the tail is read: the last event is in it. */
const TAIL = 4096

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > LAST_ACTIVITY_MAX ? t.slice(0, LAST_ACTIVITY_MAX - 1) + "…" : t
}

/** The last event of a task's output as one line, or undefined before any. */
export function lastActivityOf(buffer: string | undefined): string | undefined {
  if (!buffer) return undefined
  const lines = buffer.slice(-TAIL).split("\n")
  // The last line may still be arriving: read it only when it is the only one.
  if (lines.length > 1 && !buffer.endsWith("\n")) lines.pop()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith("→ ")) {
      const call = line.slice(2)
      const open = call.indexOf("(")
      return clip("Using " + (open > 0 ? call.slice(0, open) : call))
    }
    if (line.startsWith("← ")) return line.slice(2).startsWith("[error] ") ? "A tool failed" : "Read a tool result"
    if (line.startsWith("💭 ")) return clip("Thinking: " + line.slice(3))
    if (line.startsWith("· ")) return clip(line.slice(2))
    if (line.startsWith("[error] ")) return clip("Error: " + line.slice(8))
    if (line.startsWith("[task finished]")) return "Finished"
    return clip("Writing: " + line)
  }
  return undefined
}
