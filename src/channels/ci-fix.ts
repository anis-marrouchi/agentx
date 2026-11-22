import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname } from "path"
import { detectAgentxMarker, UNKNOWN_AGENT } from "./outbound-marker"

// --- The CI fix loop (#2102) ---
//
// A red pipeline on an MR/PR wakes the agent that owns it, to fix CI on its
// branch. The rules, per MR/PR (key <provider>:<repo>:<number>):
//   - every red workflow run / pipeline of one head commit that arrives
//     within the hold window goes into one wake;
//   - at most one wake per head commit: later reds on a commit already
//     woken neither wake nor count;
//   - a repeated delivery of one run is dropped;
//   - past `ci.fixAttempts` wakes on the MR/PR, across commits, no more
//     wakes, and one note asks a person to look;
//   - a green run on the MR/PR's head commit resets all of it, unless that
//     commit had a red: a branch pipeline that passes beside a failing MR
//     pipeline, or a late green of an older commit, resets nothing.
// The count is saved before the wake is sent, so a crash mid-wake does not
// give the loop a free try.

export const CI_FIX_ATTEMPTS_DEFAULT = 3
/** The hold window: the same as channels.github.debounceSeconds' default. */
export const CI_HOLD_SECONDS_DEFAULT = 30
/** How long a delivery is remembered for dropping its repeats. */
const DELIVERY_TTL_MS = 60 * 60 * 1000

interface Entry {
  /** Wakes sent on this MR/PR since its last green run. */
  count: number
  /** The last head commit a wake was decided for. */
  sha?: string
  /** The "still red" note was posted. */
  noted?: boolean
  /** The "no agent owns this" note was posted. */
  ownerNoted?: boolean
}

/** wake: run the agent. note: post the one "still red" note. silent: neither. */
export type CiFixDecision = { action: "wake" | "note" | "silent"; count: number }

export function ciFixKey(provider: string, repo: string, number: number | string): string {
  return `${provider}:${repo}:${number}`
}

interface Held<F> { sha: string; failures: F[]; timer: ReturnType<typeof setTimeout> }

export interface CiFixLoopOptions {
  /** Where the counts persist. Unset: in memory only. */
  file?: string
  /** ci.fixAttempts, read live. */
  cap: () => number
  /** ci.holdSeconds, read live. */
  holdSeconds: () => number
  log?: (msg: string) => void
}

export class CiFixLoop<F> {
  private entries: Record<string, Entry> = {}
  private held = new Map<string, Held<F>>()
  private deliveries = new Map<string, number>()
  private inflight = new Set<Promise<void>>()
  private readonly log: (msg: string) => void

  constructor(private readonly opts: CiFixLoopOptions) {
    this.log = opts.log ?? (() => {})
    const file = opts.file
    if (file && existsSync(file)) {
      try { this.entries = JSON.parse(readFileSync(file, "utf-8")) as Record<string, Entry> } catch { this.entries = {} }
    }
  }

  /** True when `delivery` was already seen (a webhook retry or redelivery). */
  repeat(delivery: string, now = Date.now()): boolean {
    for (const [k, until] of this.deliveries) if (until <= now) this.deliveries.delete(k)
    if (this.deliveries.has(delivery)) return true
    this.deliveries.set(delivery, now + DELIVERY_TTL_MS)
    return false
  }

  /**
   * One red run on `key` at `sha`. The first red of a new commit is held
   * for the window; later reds of that commit join it. When the window
   * ends, `flush` gets every red of the commit, once.
   */
  red(key: string, sha: string, failure: F, flush: (sha: string, failures: F[]) => Promise<void>): "held" | "joined" | "dropped" {
    const e = this.entries[key]
    if (e?.sha === sha) return "dropped"
    const cap = this.opts.cap()
    if (cap <= 0 || (e && e.count >= cap && e.noted)) return "dropped"
    const held = this.held.get(key)
    if (held?.sha === sha) {
      held.failures.push(failure)
      return "joined"
    }
    if (held) {
      clearTimeout(held.timer)
      this.log(`${key}: a red run on ${sha} replaces the held one on ${held.sha}`)
    }
    const failures = [failure]
    const fire = () => {
      this.held.delete(key)
      // Claim the commit now: a red arriving while flush reads the forge
      // must not start a second wake.
      this.entries[key] = { ...(this.entries[key] ?? { count: 0 }), sha }
      const p = flush(sha, failures)
        .catch((err: Error) => this.log(`${key}: CI fix wake failed: ${err?.message ?? err}`))
        .finally(() => this.inflight.delete(p))
      this.inflight.add(p)
    }
    const ms = Math.max(0, this.opts.holdSeconds()) * 1000
    const timer = setTimeout(fire, ms)
    timer.unref?.()
    this.held.set(key, { sha, failures, timer })
    return "held"
  }

  /**
   * A green run of `sha` while the MR/PR's head is `headSha`. It resets the
   * count and drops an older commit's held red only when `sha` is the head
   * and that commit had no red (held or woken): one green pipeline beside a
   * red one on the same commit is not a green commit. True when it reset.
   */
  green(key: string, sha: string, headSha: string): boolean {
    if (!sha || sha !== headSha) return false
    const held = this.held.get(key)
    if (held?.sha === sha || this.entries[key]?.sha === sha) return false
    if (held) {
      clearTimeout(held.timer)
      this.held.delete(key)
    }
    if (this.entries[key]) {
      delete this.entries[key]
      this.save()
    }
    return true
  }

  /** Count one wake on `key`, saved before it returns. Past the cap: the
   *  note once, then silent. */
  claim(key: string): CiFixDecision {
    const e = this.entries[key] ?? { count: 0 }
    const cap = this.opts.cap()
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

  /** True the first time only: post the "no agent owns this" note. */
  noOwnerNoteOnce(key: string): boolean {
    const e = this.entries[key] ?? { count: 0 }
    if (e.ownerNoted) return false
    this.entries[key] = { ...e, ownerNoted: true }
    this.save()
    return true
  }

  /** True when `key` has a count, a note or a held red. */
  has(key: string): boolean {
    return !!this.entries[key] || this.held.has(key)
  }

  /** True when some MR/PR under `prefix` has a count or a held red. */
  tracks(prefix: string): boolean {
    return Object.keys(this.entries).some((k) => k.startsWith(prefix))
      || [...this.held.keys()].some((k) => k.startsWith(prefix))
  }

  /** Resolves when every wake started so far has been sent (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight])
  }

  stop(): void {
    for (const h of this.held.values()) clearTimeout(h.timer)
    this.held.clear()
  }

  private save(): void {
    const file = this.opts.file
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(this.entries, null, 2))
    } catch { /* a lost count only means one more wake */ }
  }
}

/** The agent that owns an MR/PR for a CI fix: the AgentX marker in its
 *  description when it names a registered agent, else the open request on
 *  the issue its `agentx/issue-<n>` branch names. Never the route agent, never the author: undefined means
 *  nobody owns it. */
export function ciOwner(input: {
  body?: string | null
  branch?: string | null
  agentForIssue?: (n: number) => string | undefined
  /** The registered agent ids. Set: a marker naming another id is ignored,
   *  since anyone who can edit the description can write one. */
  knownAgentIds?: readonly string[]
}): { agentId: string; via: "marker" | "branch" } | undefined {
  const marked = detectAgentxMarker(input.body)
  if (marked && marked !== UNKNOWN_AGENT && (!input.knownAgentIds || input.knownAgentIds.includes(marked))) {
    return { agentId: marked, via: "marker" }
  }
  const m = input.branch?.match(/^agentx\/issue-(\d+)$/)
  if (m && input.agentForIssue) {
    const agentId = input.agentForIssue(Number(m[1]))
    if (agentId) return { agentId, via: "branch" }
  }
  return undefined
}

/** The home links a request on issue `n` of `repo` may carry (#394). */
export function issueHomeLinks(provider: "github" | "gitlab", repo: string, n: number, gitlabHost?: string): string[] {
  const links = [`${repo}#${n}`]
  if (provider === "github") links.push(`https://github.com/${repo}/issues/${n}`)
  else if (gitlabHost) {
    const host = gitlabHost.replace(/\/+$/, "")
    links.push(`${host}/${repo}/-/issues/${n}`, `${host}/${repo}/issues/${n}`)
  }
  return links
}

/** The note posted once the cap is reached. */
export function ciStillRedNote(tries: number, sha: string): string {
  return `CI is still red after ${tries} ${tries === 1 ? "try" : "tries"} (latest commit ${sha.slice(0, 12)}). The agent will not be woken again for CI here until it passes; could a person take a look?`
}

/** The note posted once when no agent owns the MR/PR. */
export function ciNoOwnerNote(sha: string): string {
  return `CI failed on ${sha.slice(0, 12)}, and no agent owns this: its description has no AgentX marker and its branch is not agentx/issue-<n> with an open request. No agent was woken; could a person take a look?`
}
