import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import type { InterruptedRun } from "@/storage/traces"

// --- What a resumed run is told, and the boot history behind the crash-loop brake ---

const MAX_LISTED_CALLS = 15
const MAX_CALL_CHARS = 160

/** Prepended to the original request of a resumed run. The provider
 *  session of a turn cut off mid-way can't be continued (its id is only
 *  known when the turn finishes), so the agent restarts the turn from its
 *  previous context. The tool calls it had already made are listed from the
 *  trace, so it can check before doing an outside action twice. */
export function buildResumeNote(run: InterruptedRun): string {
  const at = new Date(run.startedAt).toISOString().slice(11, 16)
  const lines = [
    `[Resumed after a restart] You started on this request at ${at} UTC, and AgentX restarted before you finished.`,
  ]
  if (run.toolCalls.length === 0) {
    lines.push("You had not made any tool calls yet.")
  } else {
    lines.push(`You had already made these tool calls (${run.toolCalls.length}):`)
    run.toolCalls.slice(0, MAX_LISTED_CALLS).forEach((c, i) => {
      const input = (c.inputSummary ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_CALL_CHARS)
      lines.push(`${i + 1}. ${c.action ?? "tool"}${input ? `: ${input}` : ""}`)
    })
    if (run.toolCalls.length > MAX_LISTED_CALLS) lines.push(`…and ${run.toolCalls.length - MAX_LISTED_CALLS} more.`)
    lines.push(
      "Before repeating anything that changes the outside world — posting a comment or message, " +
      "pushing, merging, deploying, sending — check whether it already happened.",
    )
  }
  lines.push("Then finish the request below.", "")
  return lines.join("\n")
}

// Boot history: when the daemon started recently, for the crash-loop brake.

const BOOT_FILE = "boot-history.json"
const KEEP_BOOTS = 20

/** Record this boot and return recent boot times (ms), this one included. */
export function recordBoot(agentxDir: string, now = Date.now()): number[] {
  const path = resolve(agentxDir, BOOT_FILE)
  let boots: number[] = []
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8"))
      if (Array.isArray(parsed)) boots = parsed.filter((t) => typeof t === "number")
    }
  } catch { /* corrupt history → start fresh */ }
  boots = [...boots, now].slice(-KEEP_BOOTS)
  try {
    mkdirSync(agentxDir, { recursive: true })
    writeFileSync(path, JSON.stringify(boots))
  } catch { /* best effort: without history the brake just can't trip */ }
  return boots
}
