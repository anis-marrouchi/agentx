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
//
// A review or a reviewer-signed comment is kept per PR and head commit
// (`ended`, persisted): a later green of that same commit (a re-run, or a
// workflow that finishes after the comment) does not start the wait again.
// A PR that needs no wait on a commit (release, fork, no owner) is kept in
// memory (`skipped`), so repeat greens of it read nothing from GitHub.
// A new push clears both for the PR; a close forgets the PR.

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

/** Skipped PR commits kept in memory, at most. */
const SKIPPED_MAX = 1000

interface ReviewWaitFile { waits: Record<string, ReviewWaitEntry>; ended?: Record<string, string> }

export class ReviewWait {
  private entries: Record<string, ReviewWaitEntry> = {}
  /** key → head commit a review or reviewer comment reached (#2368 C1). */
  private ended: Record<string, string> = {}
  /** key → head commit that needs no wait (release, fork, no owner). */
  private skipped = new Map<string, string>()

  constructor(private readonly opts: ReviewWaitOptions) {
    if (opts.file && existsSync(opts.file)) {
      try {
        const raw = JSON.parse(readFileSync(opts.file, "utf-8")) as Partial<ReviewWaitFile> & Record<string, unknown>
        // A file from before `ended` existed is the waits map itself.
        if (raw && typeof raw.waits === "object" && raw.waits) {
          this.entries = raw.waits as Record<string, ReviewWaitEntry>
          this.ended = (raw.ended ?? {}) as Record<string, string>
        } else this.entries = raw as Record<string, ReviewWaitEntry>
      } catch { this.entries = {}; this.ended = {} }
    }
  }

  /** The head commit `entry.sha` is all green. True when a wait started
   *  (a new PR or a new head); a repeat green of the same head keeps it,
   *  and a head already reviewed starts none. */
  green(key: string, entry: Omit<ReviewWaitEntry, "woke" | "wokeAt" | "told">): boolean {
    if (this.entries[key]?.sha === entry.sha) return false
    if (this.ended[key] === entry.sha) return false
    this.entries[key] = { ...entry }
    this.save()
    return true
  }

  /** The PR's head moved to `sha`: a wait on an older commit ends, and a
   *  review or skip of an older commit no longer counts. */
  pushed(key: string, sha: string): boolean {
    if (this.skipped.has(key) && this.skipped.get(key) !== sha) this.skipped.delete(key)
    let changed = false
    if (this.ended[key] !== undefined && this.ended[key] !== sha) { delete this.ended[key]; changed = true }
    const e = this.entries[key]
    if (!e || e.sha === sha) { if (changed) this.save(); return false }
    return this.end(key)
  }

  /** A review, or a comment signed by the reviewer, reached the PR on head
   *  commit `sha`: the wait ends and that commit starts none again. True
   *  when a running wait ended. */
  reviewed(key: string, sha?: string | null): boolean {
    const head = sha || this.entries[key]?.sha
    if (head) { this.ended[key] = head; this.save() }
    return this.end(key)
  }

  /** The PR closed or merged: nothing is kept for it. */
  forget(key: string): boolean {
    this.skipped.delete(key)
    const had = this.ended[key] !== undefined
    delete this.ended[key]
    const ended = this.end(key)
    if (had && !ended) this.save()
    return ended
  }

  /** Commit `sha` of the PR needs no wait (release, fork, no owner). */
  skip(key: string, sha: string): void {
    this.skipped.delete(key)
    this.skipped.set(key, sha)
    if (this.skipped.size > SKIPPED_MAX) this.skipped.delete(this.skipped.keys().next().value as string)
  }

  /** True when a green of `sha` on `key` needs no look at GitHub: a wait
   *  runs on it, it was reviewed, or it needs no wait (#2368 C2). */
  settled(key: string, sha: string): boolean {
    return this.waiting(key, sha) || this.ended[key] === sha || this.skipped.get(key) === sha
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
      const data: ReviewWaitFile = { waits: this.entries, ended: this.ended }
      writeFileSync(file, JSON.stringify(data, null, 2))
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
