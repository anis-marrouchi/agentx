import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, join } from "path"
import type Database from "better-sqlite3"
import type { CiStillRed } from "./ci-fix"

// --- "CI still red after N tries" beyond the forge note (#2212) ---
//
// When an MR/PR has used up ci.fixAttempts wakes, the channel posts one
// note on the forge and keeps the note's details beside the count in its
// CI fix state file. From there:
//   - the Needs you list (the inbox's `ci` kind) shows one item per MR/PR;
//   - the item leaves when a green run on the head resets the count or the
//     MR/PR closes (both drop the entry), or when the owner answers it;
//   - one `ci_still_red` step goes on the owning agent's last run on that
//     MR/PR, so the outcome shows on the run timeline.
// The state files stay the channels' to write. An answer from Needs you
// goes to a file of its own, so it never races the channel's saves.

/** Where the channels keep their CI fix counts (daemon/index.ts). */
export function ciStateFiles(root: string): string[] {
  return ["github", "gitlab"].map((p) => join(root, ".agentx", "state", `ci-fix-${p}.json`))
}

function answeredFile(root: string): string {
  return join(root, ".agentx", "state", "ci-still-red-answered.json")
}

function readJson<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined
  try { return JSON.parse(readFileSync(file, "utf-8")) as T } catch { return undefined }
}

/** The MR/PRs still red past the cap, keyed by their CI fix key, oldest
 *  note first. An answered one stays answered until a new note. */
export function readCiStillRed(root: string): Array<CiStillRed & { key: string }> {
  const answered = readJson<Record<string, string>>(answeredFile(root)) ?? {}
  const out: Array<CiStillRed & { key: string }> = []
  for (const file of ciStateFiles(root)) {
    const entries = readJson<Record<string, { noted?: boolean; red?: CiStillRed }>>(file) ?? {}
    for (const [key, e] of Object.entries(entries)) {
      if (!e?.noted || !e.red || answered[key] === e.red.at) continue
      out.push({ ...e.red, key })
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/** The owner answered the item: it leaves Needs you until the next note. */
export function answerCiStillRed(root: string, key: string): boolean {
  const item = readCiStillRed(root).find((r) => r.key === key)
  if (!item) return false
  const file = answeredFile(root)
  const answered = readJson<Record<string, string>>(file) ?? {}
  // Drop answers whose MR/PR is no longer tracked, so the file stays small.
  const live = new Set<string>()
  for (const f of ciStateFiles(root)) for (const k of Object.keys(readJson<Record<string, unknown>>(f) ?? {})) live.add(k)
  for (const k of Object.keys(answered)) if (!live.has(k)) delete answered[k]
  answered[key] = item.at
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(answered, null, 2))
  return true
}

/** "PR #12" on GitHub, "MR !12" on GitLab. */
export function ciStillRedRef(r: Pick<CiStillRed, "provider" | "number">): string {
  return r.provider === "github" ? `PR #${r.number}` : `MR !${r.number}`
}

/** The chat the channel's CI fix wakes run on, as the trace records it. */
export function ciChatId(r: Pick<CiStillRed, "provider" | "repo" | "number">): string {
  return r.provider === "github" ? `${r.repo}:pull:${r.number}` : `${r.repo}:merge_request:${r.number}`
}

/** One `ci_still_red` step on the owning agent's last run on the MR/PR.
 *  Returns the run's id, or undefined when the agent has no run there. */
export function recordCiStillRedStep(
  r: CiStillRed,
  deps: {
    db: Database.Database
    lastRun: (db: Database.Database, f: { agentId: string; channel: string; chatId: string; limit: number }) => Array<{ taskId: string }>
    emit: (step: { taskId: string; agentId: string; name: string; action: string; status: "error"; outputSummary: string; at: string }) => void
  },
): string | undefined {
  const run = deps.lastRun(deps.db, { agentId: r.agentId, channel: r.provider, chatId: ciChatId(r), limit: 1 })[0]
  if (!run) return undefined
  deps.emit({
    taskId: run.taskId,
    agentId: r.agentId,
    name: "ci_still_red",
    action: `${r.repo} ${ciStillRedRef(r)}`,
    status: "error",
    outputSummary: `CI still red after ${r.tries} ${r.tries === 1 ? "try" : "tries"} on ${r.sha.slice(0, 12)}; no more CI fix wakes, a person was asked to look${r.url ? `: ${r.url}` : ""}`,
    at: r.at,
  })
  return run.taskId
}
