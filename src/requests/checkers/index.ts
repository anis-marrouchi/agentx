import { checkUrl, parseUrlSpec } from "./url"
import { checkIssue, parseIssueSpec, type ForgeReader } from "./issue"
import { checkGitAncestor, parseGitAncestorSpec, type GitRunner } from "./git-ancestor"
import { checkReply, parseReplySpec, type InboundLog } from "./reply"

// --- Evidence that closes an open loop (#1039) ---
//
// A request (a loop) can carry a `close_when`: a checker spec that says
// what proves it is finished. The requests check runs it; `met` closes the
// loop as done with the evidence the checker wrote. An agent's `done` on
// such a loop runs it too: `not_met` refuses the close, `unverifiable`
// leaves it open and marks it unverified. Only the owner closes a loop by
// hand without the check.
//
// Each checker answers met, not_met or unverifiable, never throws. Plan
// steps (#788) use the `url` checker for their URL check.

export const CHECK_KINDS = ["url", "issue", "git-ancestor", "reply"] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

export type CheckVerdict = "met" | "not_met" | "unverifiable"

export interface CheckResult {
  verdict: CheckVerdict
  /** The evidence when met; what was seen, or why it could not be
   *  checked, otherwise. One line, for people. */
  detail: string
}

export interface UrlSpec { kind: "url"; url: string; contains?: string }
export type IssueState = "open" | "closed" | "merged"
export interface IssueSpec { kind: "issue"; provider: "github" | "gitlab"; ref: string; state?: IssueState; notePattern?: string }
export interface GitAncestorSpec { kind: "git-ancestor"; repo: string; commit: string; ref?: string }
export interface ReplySpec { kind: "reply"; channel: string; chatId: string; from: string; after?: number }
export type CloseWhen = UrlSpec | IssueSpec | GitAncestorSpec | ReplySpec

/** `requests.checkers` in agentx.json. */
export interface CheckerSettings {
  /** Kinds an agent may use. A loop of a kind turned off is unverifiable. */
  enabled: CheckKind[]
  /** How often the requests check runs a loop's checker. */
  checkEveryMinutes: number
  /** Local clones the git-ancestor checker may read, by name. */
  repos: Record<string, string>
  /** The connectors of the issue checker. Unset: channels.github and
   *  channels.gitlab. */
  github?: { apiUrl?: string; token?: string }
  gitlab?: { url?: string; token?: string }
}

export const DEFAULT_CHECKER_SETTINGS: CheckerSettings = {
  enabled: [...CHECK_KINDS], checkEveryMinutes: 10, repos: {},
}

export interface CheckContext {
  now: number
  settings: CheckerSettings
  fetch?: typeof fetch
  /** issue: reads an issue or merge request through the connector. */
  forge?: ForgeReader
  /** git-ancestor: runs git. Default: the git on this machine. */
  git?: GitRunner
  /** reply: the daemon's record of inbound turns. */
  inbound?: InboundLog
}

export const SPEC_MAX = 2000

/** Check what an agent sent as `closeWhen`. A spec, or the reason it is
 *  refused. `now` is the default `after` of a reply check: a reply only
 *  counts once the loop is open. */
export function parseCloseWhen(v: unknown, settings: CheckerSettings = DEFAULT_CHECKER_SETTINGS, now = Date.now()): CloseWhen | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "closeWhen must be an object with a kind: url, issue, git-ancestor or reply"
  const raw = v as Record<string, unknown>
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : ""
  if (!(CHECK_KINDS as readonly string[]).includes(kind)) return `closeWhen.kind must be one of ${CHECK_KINDS.join(", ")}`
  if (!settings.enabled.includes(kind as CheckKind)) return `the ${kind} check is turned off on this node (requests.checkers.enabled)`
  const spec = kind === "url" ? parseUrlSpec(raw)
    : kind === "issue" ? parseIssueSpec(raw)
    : kind === "git-ancestor" ? parseGitAncestorSpec(raw, settings)
    : parseReplySpec(raw, now)
  if (typeof spec === "string") return `closeWhen: ${spec}`
  if (JSON.stringify(spec).length > SPEC_MAX) return `closeWhen is longer than ${SPEC_MAX} characters`
  return spec
}

/** Run the checker of `spec`. Never throws. */
export async function runCheck(spec: CloseWhen, ctx: CheckContext): Promise<CheckResult> {
  if (!ctx.settings.enabled.includes(spec.kind)) {
    return { verdict: "unverifiable", detail: `the ${spec.kind} check is turned off on this node (requests.checkers.enabled)` }
  }
  try {
    switch (spec.kind) {
      case "url": return await checkUrl(spec, ctx)
      case "issue": return await checkIssue(spec, ctx)
      case "git-ancestor": return await checkGitAncestor(spec, ctx)
      case "reply": return await checkReply(spec, ctx)
    }
  } catch (e: any) {
    return { verdict: "unverifiable", detail: `the ${(spec as CloseWhen).kind} check failed: ${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** What the check waits for, in words. */
export function describeCloseWhen(spec: CloseWhen): string {
  switch (spec.kind) {
    case "url": return `${spec.url} answers${spec.contains ? ` with "${spec.contains}"` : ""}`
    case "issue": {
      const what = [spec.state || !spec.notePattern ? `is ${spec.state ?? "closed"}` : null, spec.notePattern ? `has a note with "${spec.notePattern}"` : null]
      return `${spec.provider} ${spec.ref} ${what.filter(Boolean).join(" or ")}`
    }
    case "git-ancestor": return `commit ${spec.commit} is in ${spec.ref ?? "HEAD"} of ${spec.repo}`
    case "reply": return `${spec.from} replies on ${spec.channel} chat ${spec.chatId}`
  }
}

/** A stored spec read back. Null when it is not one (an older or broken row). */
export function readCloseWhen(json: string | null | undefined): CloseWhen | null {
  if (!json) return null
  try {
    const v = JSON.parse(json)
    return v && typeof v === "object" && (CHECK_KINDS as readonly string[]).includes(v.kind) ? v as CloseWhen : null
  } catch {
    return null
  }
}

export type { ForgeReader, GitRunner, InboundLog }
