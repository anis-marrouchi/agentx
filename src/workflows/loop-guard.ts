// --- Loop guard for event-triggered workflows (trigger.hook) ---
//
// Generator/critic routine pairs can loop: a routine posts as its bot
// identity, the forge emits an event for that post, and the same routine
// (or its partner) wakes up again. Three gates, evaluated after the
// regular trigger filters in triggers.ts:
//
//   1. Self-authored skip (opt-in via `filter.skipSelfAuthored: true`).
//      Off by default because label-driven lifecycle workflows react to
//      their own agent's transitions on purpose. The event author is the forge
//      identity of an agent the workflow itself runs. Identity comes from
//      `ctx.authorAgent` (stamped by the GitLab adapter from its
//      token-resolved username map or the agentx comment signature) or from
//      the configured forge usernames of the workflow's agents.
//   2. `filter.ignoreAuthors` — explicit usernames to skip.
//   3. `filter.maxFiresPerTarget: { count, windowMinutes }` — at most
//      `count` fires of this workflow for the same issue/MR/PR inside a
//      sliding window. Stops two-routine ping-pong that (1) can't see
//      because each routine is woken by the *other* routine's identity.

import type { Workflow } from "./types"

export interface LoopGuardFilter {
  ignoreAuthors?: string[]
  skipSelfAuthored?: boolean
  maxFiresPerTarget?: { count?: number; windowMinutes?: number }
}

export type LoopGuardVerdict =
  | { skip: false }
  | { skip: true; reason: "self-authored" | "ignored-author" | "chain-limit"; detail: string }

const norm = (u: string): string => u.trim().toLowerCase().replace(/^@/, "")

/** Event author username, normalized. Adapters stamp `author`; older
 *  gitlab-note contexts carry `authorUsername`; GitHub contexts fall back to
 *  the raw webhook `sender.login`. */
export function eventAuthor(ctx: Record<string, unknown>): string | undefined {
  const direct = typeof ctx.author === "string" ? ctx.author
    : typeof ctx.authorUsername === "string" ? ctx.authorUsername
    : undefined
  if (direct) return norm(direct)
  const payload = ctx.payload as { sender?: { login?: unknown } } | undefined
  const login = payload?.sender?.login
  return typeof login === "string" && login ? norm(login) : undefined
}

/** Stable key for the thing the event is about, shared across event types
 *  so a note on MR !5 and an update of MR !5 count against the same target.
 *  Undefined when the event has no issue/MR/PR (pushes, pipelines, n8n). */
export function eventTargetKey(event: string, ctx: Record<string, unknown>): string | undefined {
  const project = typeof ctx.project === "string" ? ctx.project : ""
  if (event === "on:gitlab-issue" || event === "on:gitlab-mr") {
    if (!project || ctx.iid == null) return undefined
    return `gitlab:${project}${event === "on:gitlab-issue" ? "#" : "!"}${String(ctx.iid)}`
  }
  if (event === "on:gitlab-note") {
    const iid = ctx.noteableIid != null ? String(ctx.noteableIid) : ""
    const type = typeof ctx.noteableType === "string" ? ctx.noteableType : ""
    if (!project || !iid || !type) return undefined
    return `gitlab:${project}${type === "issue" ? "#" : "!"}${iid}`
  }
  if (event === "on:github-issue" || event === "on:github-pr") {
    const payload = (ctx.payload ?? {}) as {
      repository?: { full_name?: unknown }
      issue?: { number?: unknown }
      pull_request?: { number?: unknown }
    }
    const repo = typeof ctx.repo === "string" ? ctx.repo : payload.repository?.full_name
    const num = ctx.number ?? payload.issue?.number ?? payload.pull_request?.number
    if (typeof repo !== "string" || !repo || num == null) return undefined
    // Issues and PRs share one number space on GitHub, so one separator.
    return `github:${repo}#${String(num)}`
  }
  return undefined
}

/** Agent ids a workflow acts as — every `agent` node's config.agentId. */
export function workflowAgentIds(wf: Pick<Workflow, "nodes">): string[] {
  const out = new Set<string>()
  for (const n of wf.nodes) {
    const id = n.type === "agent" ? (n.config as { agentId?: unknown }).agentId : undefined
    if (typeof id === "string" && id) out.add(id)
  }
  return [...out]
}

/** Sliding-window fire counter keyed by `<workflowId>|<target>`.
 *  In-memory on purpose: a daemon restart resets the windows, which at worst
 *  lets a looping pair run one more window before it is capped again. The
 *  map is bounded — oldest keys are evicted past `maxKeys`. */
export class FireWindow {
  private fires = new Map<string, number[]>()
  constructor(private readonly maxKeys = 2000) {}

  /** Record a fire unless `count` fires already landed inside the window.
   *  Returns false (and records nothing) when the limit is hit. */
  tryFire(key: string, count: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.fires.get(key) ?? []).filter((t) => now - t < windowMs)
    if (recent.length >= count) {
      this.fires.set(key, recent)
      return false
    }
    recent.push(now)
    // Re-insert so Map iteration order approximates least-recently-fired.
    this.fires.delete(key)
    this.fires.set(key, recent)
    while (this.fires.size > this.maxKeys) {
      const oldest = this.fires.keys().next().value
      if (oldest === undefined) break
      this.fires.delete(oldest)
    }
    return true
  }

  get size(): number { return this.fires.size }
}

export interface LoopGuardDeps {
  /** Configured forge usernames for an agent (GitLab/GitHub agentMappings). */
  forgeUsernames?: (agentId: string) => string[]
  fireWindow: FireWindow
  /** Log sink; `once` keys de-duplicate repeated notices per process. */
  log: (msg: string) => void
  logged?: Set<string>
  now?: () => number
}

function logOnce(deps: LoopGuardDeps, key: string, msg: string): void {
  const seen = deps.logged ?? (deps.logged = new Set())
  if (seen.has(key)) return
  seen.add(key)
  deps.log(msg)
}

/** Decide whether a trigger.hook fire should be skipped as a loop.
 *  The chain-limit counter is only advanced when the verdict is "fire". */
export function checkLoopGuard(
  wf: Pick<Workflow, "id" | "nodes">,
  event: string,
  ctx: Record<string, unknown>,
  filter: LoopGuardFilter | undefined,
  deps: LoopGuardDeps,
): LoopGuardVerdict {
  const author = eventAuthor(ctx)

  if (author && Array.isArray(filter?.ignoreAuthors) && filter!.ignoreAuthors.length > 0) {
    if (filter!.ignoreAuthors.map(norm).includes(author)) {
      return { skip: true, reason: "ignored-author", detail: `author @${author} is in filter.ignoreAuthors` }
    }
  }

  if (filter?.skipSelfAuthored === true) {
    const agents = workflowAgentIds(wf)
    const authorAgent = typeof ctx.authorAgent === "string" ? ctx.authorAgent : undefined
    if (authorAgent && agents.includes(authorAgent)) {
      return { skip: true, reason: "self-authored", detail: `author @${author ?? "?"} is agent "${authorAgent}" which this workflow runs` }
    }
    if (author) {
      const own = new Set(agents.flatMap((a) => (deps.forgeUsernames?.(a) ?? []).map(norm)))
      if (own.has(author)) {
        return { skip: true, reason: "self-authored", detail: `author @${author} is this workflow's own bot identity` }
      }
      if (agents.length === 0) {
        logOnce(deps, `noagents:${wf.id}`, `[workflows] ${wf.id} has no agent node — self-authored skip can't resolve a bot identity; only filter.ignoreAuthors applies`)
      } else if (own.size === 0 && !("authorAgent" in ctx)) {
        logOnce(deps, `noident:${wf.id}:${event}`, `[workflows] ${wf.id} no forge username known for agent(s) ${agents.join(", ")} on ${event} — self-authored skip inactive; only filter.ignoreAuthors applies`)
      }
    }
  }

  const limit = filter?.maxFiresPerTarget
  if (limit && typeof limit.count === "number" && limit.count > 0) {
    const target = eventTargetKey(event, ctx)
    if (target) {
      const windowMinutes = typeof limit.windowMinutes === "number" && limit.windowMinutes > 0 ? limit.windowMinutes : 60
      const now = deps.now?.() ?? Date.now()
      if (!deps.fireWindow.tryFire(`${wf.id}|${target}`, limit.count, windowMinutes * 60_000, now)) {
        return {
          skip: true,
          reason: "chain-limit",
          detail: `${target} already fired ${limit.count}x within ${windowMinutes}m (filter.maxFiresPerTarget)`,
        }
      }
    } else {
      logOnce(deps, `notarget:${wf.id}:${event}`, `[workflows] ${wf.id} filter.maxFiresPerTarget has no target key for ${event} — limit not applied`)
    }
  }

  return { skip: false }
}
