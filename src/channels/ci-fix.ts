import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname } from "path"

// --- The CI fix loop's cap (#2102) ---
//
// A red pipeline on an MR/PR wakes the agent that owns it. Each wake on
// one head commit counts; past `ci.fixAttempts` the agent is not woken
// again on that commit, and one note asks a person to look. A green run
// on the MR/PR clears its counts. Keys: <provider>:<repo>:<number>:<sha>.

export const CI_FIX_ATTEMPTS_DEFAULT = 3

interface Entry { count: number; noted?: boolean }

/** wake: run the agent. note: post the one "still red" note. silent: neither. */
export type CiFixDecision = { action: "wake" | "note" | "silent"; count: number }

export function ciFixKey(provider: string, repo: string, number: number | string, sha: string): string {
  return `${provider}:${repo}:${number}:${sha}`
}

export class CiFixCounter {
  private entries: Record<string, Entry> = {}

  /** `file` unset keeps the counts in memory only. */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try { this.entries = JSON.parse(readFileSync(file, "utf-8")) as Record<string, Entry> } catch { this.entries = {} }
    }
  }

  /** Count one red run for `key` against `cap`. A cap of 0 never wakes. */
  attempt(key: string, cap: number): CiFixDecision {
    const e = this.entries[key] ?? { count: 0 }
    if (cap <= 0) return { action: "silent", count: e.count }
    if (e.count >= cap) {
      if (e.noted) return { action: "silent", count: e.count }
      this.entries[key] = { ...e, noted: true }
      this.save()
      return { action: "note", count: e.count }
    }
    this.entries[key] = { ...e, count: e.count + 1 }
    this.save()
    return { action: "wake", count: e.count + 1 }
  }

  /** A green run: forget every commit's count for this MR/PR. */
  clear(provider: string, repo: string, number: number | string): void {
    const prefix = `${provider}:${repo}:${number}:`
    let changed = false
    for (const k of Object.keys(this.entries)) {
      if (k.startsWith(prefix)) { delete this.entries[k]; changed = true }
    }
    if (changed) this.save()
  }

  private save(): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.entries, null, 2))
    } catch { /* a lost count only means one more wake */ }
  }
}

/** The note posted once the cap is reached. */
export function ciStillRedNote(tries: number, sha: string): string {
  return `CI is still red after ${tries} ${tries === 1 ? "try" : "tries"} on ${sha.slice(0, 12)}. The agent will not be woken again for this commit; could a person take a look?`
}
