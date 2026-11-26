import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname } from "path"

// --- The green-PR review wait (#2227) ---
//
// A PR whose head commit is all green and that no review has reached waits
// for its reviewer. Per PR (key <provider>:<repo>:<number>):
//   - all runs of the head commit green: the wait starts at that time;
//     a later green of the same commit keeps the first start;
//   - a new push (another head commit) ends the wait; the next green of
//     the new head starts a new one;
//   - a review, a comment signed by the reviewer agent, or the PR closing
//     or merging ends the wait;
//   - `wakeMinutes` after the start: the reviewer is woken, once;
//   - `ownerMinutes` after the start: the PR's owner agent is told, once,
//     and only `ownerMinutes - wakeMinutes` after the reviewer was really
//     woken, never in the same tick (after downtime, or owner <= wake).
// The waits persist, and `due` works from the saved start time, so a
// daemon restart neither loses a wait nor sends a wake twice.

export const REVIEW_WAKE_MINUTES_DEFAULT = 15
export const REVIEW_OWNER_MINUTES_DEFAULT = 30

export interface ReviewWaitEntry {
  repo: string
  number: number
  sha: string
  /** When the head commit went all green, ISO. */
  greenAt: string
  /** The agent that owns the PR, told at `ownerMinutes`. */
  owner: string
  url?: string
  title?: string
  /** The reviewer was woken. */
  woke?: boolean
  /** When the reviewer was woken, ISO. */
  wokeAt?: string
  /** The owner was told. */
  told?: boolean
}

export interface ReviewWaitDue { kind: "reviewer" | "owner"; key: string; entry: ReviewWaitEntry; minutes: number }

export interface ReviewWaitOptions {
  /** Where the waits persist. Unset: in memory only. */
  file?: string
  wakeMinutes: () => number
  ownerMinutes: () => number
}

/** A release PR (release-please) waits for no reviewer. */
export function isReleasePr(title?: string | null, branch?: string | null): boolean {
  return /^chore\([^)]*\): release /.test(title ?? "") || (branch ?? "").startsWith("release-please--")
}

export class ReviewWait {
  private entries: Record<string, ReviewWaitEntry> = {}

  constructor(private readonly opts: ReviewWaitOptions) {
    if (opts.file && existsSync(opts.file)) {
      try { this.entries = JSON.parse(readFileSync(opts.file, "utf-8")) as Record<string, ReviewWaitEntry> } catch { this.entries = {} }
    }
  }

  /** The head commit `entry.sha` is all green. True when a wait started
   *  (a new PR or a new head); a repeat green of the same head keeps it. */
  green(key: string, entry: Omit<ReviewWaitEntry, "woke" | "wokeAt" | "told">): boolean {
    if (this.entries[key]?.sha === entry.sha) return false
    this.entries[key] = { ...entry }
    this.save()
    return true
  }

  /** The PR's head moved to `sha`: a wait on an older commit ends. */
  pushed(key: string, sha: string): boolean {
    const e = this.entries[key]
    if (!e || e.sha === sha) return false
    return this.end(key)
  }

  /** A review reached the PR, or it closed or merged: the wait ends. */
  end(key: string): boolean {
    if (!this.entries[key]) return false
    delete this.entries[key]
    this.save()
    return true
  }

  /** The wakes due at `now`, each returned once. A wait whose owner was
   *  told stays until it ends, so its PR is not started again on a repeat
   *  green of the same head. */
  due(now = Date.now()): ReviewWaitDue[] {
    const out: ReviewWaitDue[] = []
    const wake = this.opts.wakeMinutes()
    const owner = this.opts.ownerMinutes()
    for (const [key, e] of Object.entries(this.entries)) {
      const minutes = (now - Date.parse(e.greenAt)) / 60_000
      if (!Number.isFinite(minutes)) continue
      if (!e.woke && wake > 0 && minutes >= wake) {
        e.woke = true
        e.wokeAt = new Date(now).toISOString()
        out.push({ kind: "reviewer", key, entry: { ...e }, minutes: Math.floor(minutes) })
        continue
      }
      // The owner is told only after the reviewer had its time: at least
      // `owner - wake` minutes after the real wake, never in its tick.
      // With the reviewer wake off (wake 0) the owner goes on its own time.
      if (e.told || owner <= 0 || minutes < owner) continue
      if (wake > 0) {
        if (!e.woke) continue
        // A wait saved before wokeAt existed: its wake was due at greenAt + wake.
        const wokeAt = e.wokeAt ? Date.parse(e.wokeAt) : Date.parse(e.greenAt) + wake * 60_000
        if (!Number.isFinite(wokeAt) || (now - wokeAt) / 60_000 < Math.max(0, owner - wake)) continue
      }
      e.told = true
      out.push({ kind: "owner", key, entry: { ...e }, minutes: Math.floor(minutes) })
    }
    if (out.length) this.save()
    return out
  }

  has(key: string): boolean {
    return !!this.entries[key]
  }

  /** True when a wait runs on `key` for head commit `sha`. */
  waiting(key: string, sha: string): boolean {
    return this.entries[key]?.sha === sha
  }

  private save(): void {
    const file = this.opts.file
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(this.entries, null, 2))
    } catch { /* a lost wait only means one alert less */ }
  }
}

export function reviewWakeText(e: ReviewWaitEntry, minutes: number): string {
  return `[GitHub PR #${e.number} GREEN, NO REVIEW] ${e.repo}: every check on ${e.sha.slice(0, 8)} has been green for ${minutes} min and no review has reached the PR.\n` +
    `${e.title ? `Title: ${e.title}\n` : ""}${e.url ?? `https://github.com/${e.repo}/pull/${e.number}`}\n` +
    `\nPlease review it now. A GitHub review, or a PR comment signed by you, ends this wait. (#2227)`
}

export function reviewOwnerText(e: ReviewWaitEntry, minutes: number, reviewer: string): string {
  return `[GitHub PR #${e.number} GREEN, STILL NO REVIEW] ${e.repo}: green for ${minutes} min on ${e.sha.slice(0, 8)}; ${reviewer} was woken and no review has come.\n` +
    `${e.title ? `Title: ${e.title}\n` : ""}${e.url ?? `https://github.com/${e.repo}/pull/${e.number}`}\n` +
    `\nYou own this PR: find out from ${reviewer} when the review comes, or name another reviewer. No action on the branch is needed. (#2227)`
}
