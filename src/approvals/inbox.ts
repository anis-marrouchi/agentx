import { existsSync, readdirSync, readFileSync } from "fs"
import { resolve } from "path"
import { MemoryStore } from "@/agents/memory-store"
import { approveSchedule, formatFireTime, humanizeCron, nextFireTime, rejectSchedule } from "@/crons/schedule-ops"
import { listProposals, readProposal, type PromotionProposal } from "@/wiki/proposals"
import { approveProposal, rejectProposal } from "@/wiki/promote"
import { decideDraft, listDrafts, readDraft, type SendReply } from "@/whatsapp-triage/drafts"
import { decideCard, listCards, readCard, type DecisionCard, type IfSilent } from "./cards"
import { readInboxState, snooze } from "./state"
import { openDb } from "@/storage/sqlite"
import { RequestStore } from "@/requests/store"
import { readRequestSettings } from "@/requests/settings"

// --- The Approvals inbox: one list over every pending decision ---
//
// A read model, not a store. Each source keeps its own records and its own
// approve/reject; the inbox lists them in one shape and hands a verdict to
// the source's existing function:
//
//   card      decision cards agents raise (cards.ts)
//   schedule  schedules an agent asked to create or delete (crons/schedule-ops)
//   memory    facts from outside sources held before agents may use them
//   wiki      lessons proposed for the shared wiki (wiki/proposals, wiki/promote)
//   whatsapp  replies an agent drafted for a watched WhatsApp chat
//             (whatsapp-triage/drafts); yes sends it through wacli
//   request   something you asked for that failed, timed out, was cut off
//             or went quiet (requests/store); yes hands it back to its
//             agent, no drops it
//
// Only operator surfaces call decide(): the `agentx approvals` CLI and the
// dashboard's /api/admin/approvals. The daemon's agent-facing API and the
// MCP tool can create cards and read, never decide.

export type ApprovalKind = "card" | "schedule" | "memory" | "wiki" | "whatsapp" | "request"
export const APPROVAL_KINDS: readonly ApprovalKind[] = ["card", "schedule", "memory", "wiki", "whatsapp", "request"]

export type InboxAction = "yes" | "no" | "later"

/** One pending decision, in bounded summary form. */
export interface InboxItem {
  /** `<kind>:<ref>`: what the CLI and the dashboard pass back. */
  key: string
  kind: ApprovalKind
  title: string
  /** The yes/no question. */
  ask: string
  /** What yes and no do, in words. */
  yes: string
  no: string
  recommend?: string
  if_silent?: IfSilent
  expires?: string
  source?: string
  raised_by: string
  created_at: string
  /** A short excerpt of what is being decided. */
  detail?: string
  /** The source's own command for the full record. */
  more?: string
  /** Cards: the ready-made answers on offer; yes must pick one. */
  choices?: string[]
  snoozed_until?: string
}

export interface InboxContext {
  /** Directory holding agentx.json and .agentx/. */
  root: string
  configPath?: string
  wikiDir?: string
  /** Hot-reload the daemon after a schedule decision. Default true. */
  reload?: boolean
  now?: number
  /** Sends an approved WhatsApp reply. Default: wacli. Tests swap it. */
  sendWhatsApp?: SendReply
  /** Open requests. Default: .agentx/db.sqlite when `root` is the folder
   *  this process runs from. Tests pass their own. */
  requests?: RequestStore
}

export const DETAIL_MAX = 280

function clip(s: string, n = DETAIL_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

function configPathFor(ctx: InboxContext): string {
  if (ctx.configPath) return resolve(ctx.configPath)
  const candidates = [resolve(ctx.root, "agentx.json"), resolve(ctx.root, ".agentx", "config.json")]
  return candidates.find((c) => existsSync(c)) ?? candidates[0]
}

function wikiDirFor(ctx: InboxContext): string {
  return ctx.wikiDir ? resolve(ctx.wikiDir) : resolve(ctx.root, ".agentx", "wiki")
}

// ── Sources ──────────────────────────────────────────────────────────

function cardItems(ctx: InboxContext): InboxItem[] {
  return listCards(ctx.root, "pending").map(cardItem)
}

function cardItem(c: DecisionCard): InboxItem {
  return {
    key: `card:${c.id}`,
    kind: "card",
    title: c.title,
    ask: c.ask,
    yes: `tell ${c.raised_by} yes`,
    no: `tell ${c.raised_by} no`,
    recommend: c.recommend,
    if_silent: c.if_silent,
    expires: c.expires,
    ...(c.source ? { source: c.source } : {}),
    raised_by: c.raised_by,
    created_at: c.created_at,
    ...(c.choices ? { choices: c.choices, more: `agentx approvals popup card:${c.id}` } : {}),
    ...(c.context || c.draft ? { detail: clip([c.context, c.draft ? `Suggested message: ${c.draft}` : ""].filter(Boolean).join(" · ")) } : {}),
  }
}

function scheduleItems(ctx: InboxContext): InboxItem[] {
  const path = configPathFor(ctx)
  if (!existsSync(path)) return []
  let cfg: any
  try { cfg = JSON.parse(readFileSync(path, "utf-8")) } catch { return [] }
  const now = new Date(ctx.now ?? Date.now())
  const out: InboxItem[] = []
  for (const [id, job] of Object.entries<any>(cfg?.crons ?? {})) {
    const approval = job?.approval
    if (!approval || (approval.action !== "create" && approval.action !== "delete")) continue
    const tz = job.timezone || "UTC"
    const human = job.schedule ? humanizeCron(job.schedule) : ""
    const when = job.schedule ? `${human.charAt(0).toLowerCase()}${human.slice(1)} (${job.schedule})` : "no schedule"
    const what = String(job.prompt ?? job.command ?? "")
    const creating = approval.action === "create"
    out.push({
      key: `schedule:${id}`,
      kind: "schedule",
      title: creating ? `New schedule "${id}" for ${job.agent ?? "an agent"}` : `Delete schedule "${id}"`,
      ask: creating ? `Let ${job.agent ?? "the agent"} run this ${when}?` : `Remove the schedule "${id}" (${when})?`,
      yes: creating ? "enable it" : "remove it",
      no: creating ? "drop the request" : "keep the schedule",
      raised_by: String(approval.requestedBy ?? "unknown"),
      created_at: String(approval.requestedAt ?? ""),
      detail: clip(`${what}${creating && job.schedule ? ` · first run ${formatFireTime(nextFireTime(job.schedule, tz, now), tz)}` : ""}`),
      more: "agentx schedule list",
    })
  }
  return out
}

function memoryAgents(root: string): string[] {
  const dir = resolve(root, ".agentx", "memory")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)).sort()
}

function memoryItems(ctx: InboxContext): InboxItem[] {
  const agents = memoryAgents(ctx.root)
  if (agents.length === 0) return []
  const store = new MemoryStore(ctx.root)
  const out: InboxItem[] = []
  for (const agent of agents) {
    for (const f of store.held(agent)) {
      out.push({
        key: `memory:${agent}/${f.id}`,
        kind: "memory",
        title: `Fact ${agent} learned from ${f.source.channel}`,
        ask: `Let ${agent} use this fact in its prompts?`,
        yes: "use it",
        no: "keep it out for good",
        raised_by: agent,
        created_at: f.createdAt,
        detail: clip(f.content),
        more: `agentx memory facts held --agent ${agent}`,
      })
    }
  }
  return out
}

/** One line on what backs a wiki proposal. A lesson drawn from a
 *  recurring failure says so, with the failure, before the article text:
 *  the reviewer is judging a fix for something that keeps breaking. */
export function proposalBacking(e: PromotionProposal["evidence"]): string {
  const failures = e.sources.filter((s) => s.failure)
  if (failures.length) {
    return failures.map((s) =>
      `Recurring failure: ${s.agentId}'s ${s.failure!.tool} fails with "${s.failure!.errorClass}" in ${s.occurrences ?? 1} sessions (${s.failure!.runs} runs).`,
    ).join(" ")
  }
  return `${e.sources.length} source(s)${e.occurrences > 1 ? `, seen in ${e.occurrences} sessions` : ""}.`
}

function wikiItems(ctx: InboxContext): InboxItem[] {
  return listProposals(wikiDirFor(ctx), "pending").map((p) => {
    const e = p.evidence
    return {
      key: `wiki:${p.id}`,
      kind: "wiki" as const,
      title: p.article.title,
      ask: p.replaces ? `Update "${p.article.path}" in the shared wiki?` : `Add "${p.article.path}" to the shared wiki?`,
      yes: "write the article",
      no: "decline it",
      raised_by: e.agents.join(", ") || "wiki promote",
      created_at: p.createdAt,
      detail: clip(`${proposalBacking(e)} ${p.article.content}`),
      more: `agentx wiki proposals show ${p.id}`,
    }
  })
}

function whatsappItems(ctx: InboxContext): InboxItem[] {
  return listDrafts(ctx.root, "pending").map((d) => ({
    key: `whatsapp:${d.id}`,
    kind: "whatsapp" as const,
    title: `WhatsApp reply to ${d.chat_name || d.to}`,
    // The whole draft: the owner approves exactly what will be sent.
    ask: `Send this to ${d.chat_name || d.to}? "${d.text}"`,
    yes: "send it on WhatsApp",
    no: "drop the draft",
    raised_by: d.agent,
    created_at: d.created_at,
    detail: clip(`${d.triage}: ${d.summary}`),
    more: "agentx whatsapp triage log",
  }))
}

/** The requests store, or null when there is no database to read. */
export function requestStoreFor(ctx: InboxContext): RequestStore | null {
  if (ctx.requests) return ctx.requests
  // openDb is per process and opens the file under the working directory.
  // A folder with no database yet has no requests: do not create one.
  if (resolve(ctx.root) !== process.cwd() || !existsSync(resolve(ctx.root, ".agentx", "db.sqlite"))) return null
  const db = openDb({ quiet: true })
  if (!db) return null
  let store = requestStores.get(db)
  if (!store) requestStores.set(db, store = new RequestStore(db))
  return store
}
const requestStores = new WeakMap<object, RequestStore>()

function requestItems(ctx: InboxContext): InboxItem[] {
  const store = requestStoreFor(ctx)
  if (!store) return []
  return store.listByState("needs_attention").map((r) => ({
    key: `request:${r.id}`,
    kind: "request" as const,
    title: `Request not finished: ${clip(r.text, 80)}`,
    ask: `Ask ${r.agentId} to pick it up again?`,
    yes: `hand it back to ${r.agentId}`,
    no: "drop the request",
    raised_by: r.agentId,
    created_at: new Date(r.createdAt).toISOString(),
    detail: clip(`${r.attentionReason ?? "It needs attention"}. Asked on ${r.channel}: ${r.text}`),
    more: `agentx requests show ${r.id}`,
  }))
}

const SOURCES: Record<ApprovalKind, (ctx: InboxContext) => InboxItem[]> = {
  card: cardItems,
  schedule: scheduleItems,
  memory: memoryItems,
  wiki: wikiItems,
  whatsapp: whatsappItems,
  request: requestItems,
}

// ── Read model ───────────────────────────────────────────────────────

export interface InboxListing {
  items: InboxItem[]
  /** Hidden because the operator said "later". */
  snoozed: number
  /** Sources that couldn't be read, so an empty list isn't mistaken for "nothing waiting". */
  errors: Array<{ kind: ApprovalKind; error: string }>
}

/** Soonest expiry first; then oldest first. */
export function byUrgency(a: InboxItem, b: InboxItem): number {
  const ea = a.expires ? Date.parse(a.expires) : Infinity
  const eb = b.expires ? Date.parse(b.expires) : Infinity
  if (ea !== eb) return ea - eb
  return (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)
}

export function listInbox(ctx: InboxContext, opts: { includeSnoozed?: boolean; kinds?: ApprovalKind[] } = {}): InboxListing {
  const now = ctx.now ?? Date.now()
  const { snoozed } = readInboxState(ctx.root)
  const items: InboxItem[] = []
  const errors: InboxListing["errors"] = []
  let hidden = 0
  for (const kind of opts.kinds ?? APPROVAL_KINDS) {
    let found: InboxItem[]
    try { found = SOURCES[kind](ctx) } catch (e: any) {
      errors.push({ kind, error: String(e?.message ?? e).slice(0, 200) })
      continue
    }
    for (const item of found) {
      const until = snoozed[item.key]
      if (until && Date.parse(until) > now) {
        if (!opts.includeSnoozed) { hidden++; continue }
        item.snoozed_until = until
      }
      items.push(item)
    }
  }
  items.sort(byUrgency)
  return { items, snoozed: hidden, errors }
}

// ── Decide ───────────────────────────────────────────────────────────

export interface DecideOptions {
  /** Wiki: approve even if the article changed since the proposal. */
  force?: boolean
  /** Kept with the decision where the source records one. */
  note?: string
  /** "later": how long to put it off. */
  laterHours?: number
  by?: string
  /** Cards with choices: which one (1-based number or the label). */
  choice?: string | number
  /** Cards with a draft: the message as the operator edited it. */
  text?: string
}

export type DecideResult = { ok: true; message: string } | { ok: false; error: string }

export function parseKey(key: string): { kind: ApprovalKind; ref: string } | null {
  const i = key.indexOf(":")
  if (i <= 0) return null
  const kind = key.slice(0, i) as ApprovalKind
  const ref = key.slice(i + 1)
  if (!APPROVAL_KINDS.includes(kind) || !ref) return null
  return { kind, ref }
}

/** True while the item is still waiting in its source. */
function stillPending(ctx: InboxContext, kind: ApprovalKind, ref: string): boolean {
  switch (kind) {
    case "card": return readCard(ctx.root, ref)?.status === "pending"
    case "wiki": return readProposal(wikiDirFor(ctx), ref)?.status === "pending"
    case "whatsapp": return readDraft(ctx.root, ref)?.status === "pending"
    default: return SOURCES[kind](ctx).some((i) => i.key === `${kind}:${ref}`)
  }
}

/**
 * Apply the operator's answer through the source's own approve/reject.
 * Operator surfaces only: never expose this to agents.
 */
export async function decide(ctx: InboxContext, key: string, action: InboxAction, opts: DecideOptions = {}): Promise<DecideResult> {
  const parsed = parseKey(key)
  if (!parsed) return { ok: false, error: `unknown item "${key}": use a key from \`agentx approvals list\`` }
  const { kind, ref } = parsed
  const now = ctx.now ?? Date.now()
  const by = opts.by ?? "operator"

  if (action === "later") {
    if (!stillPending(ctx, kind, ref)) return { ok: false, error: `nothing waiting for "${key}"` }
    const hours = opts.laterHours && opts.laterHours > 0 ? opts.laterHours : 24
    const until = new Date(now + hours * 3_600_000)
    snooze(ctx.root, key, until, now)
    return { ok: true, message: `${key} put off until ${until.toISOString()}` }
  }

  const yes = action === "yes"
  switch (kind) {
    case "card": {
      const r = decideCard(ctx.root, ref, yes ? "yes" : "no", { by, note: opts.note, now, choice: opts.choice, text: opts.text })
      if (!r.ok) return r
      return { ok: true, message: `${key}: ${r.card.raised_by} will be told ${yes ? "yes" : "no"}${r.card.choice ? ` (${r.card.choice})` : ""}` }
    }
    case "schedule": {
      const r = await (yes ? approveSchedule : rejectSchedule)(ref, { configPath: configPathFor(ctx), reload: ctx.reload })
      return r.success ? { ok: true, message: r.message } : { ok: false, error: r.message }
    }
    case "memory": {
      const slash = ref.indexOf("/")
      if (slash <= 0) return { ok: false, error: `memory keys look like memory:<agent>/<fact-id>` }
      const agent = ref.slice(0, slash)
      const id = ref.slice(slash + 1)
      if (!memoryAgents(ctx.root).includes(agent)) return { ok: false, error: `no memory for agent "${agent}"` }
      const store = new MemoryStore(ctx.root)
      if (!store.held(agent).some((f) => f.id === id)) return { ok: false, error: `fact "${id}" isn't waiting for review` }
      store.review(agent, id, yes ? "approved" : "rejected", by)
      return { ok: true, message: `${key} ${yes ? "approved: the agent may use it" : "rejected: it stays out of prompts"}` }
    }
    case "wiki": {
      const dir = wikiDirFor(ctx)
      const r = yes
        ? approveProposal(dir, ref, { by, force: opts.force, now })
        : rejectProposal(dir, ref, { by, reason: opts.note, now })
      if (!r.ok) return r
      return { ok: true, message: yes ? `${r.proposal.article.path} written to the shared wiki` : `${key} rejected` }
    }
    case "whatsapp": {
      const r = await decideDraft(ctx.root, ref, yes ? "yes" : "no", { by, now, send: ctx.sendWhatsApp })
      if (!r.ok) return r
      return { ok: true, message: yes ? `${key}: sent to ${r.draft.chat_name || r.draft.to}` : `${key}: dropped, nothing sent` }
    }
    case "request": {
      const store = requestStoreFor(ctx)
      const r = store?.get(ref)
      if (!store || !r || r.state !== "needs_attention") return { ok: false, error: `nothing waiting for "${key}"` }
      if (yes) {
        // The hand-back runs in the daemon's requests check, which is off with the feature.
        if (!readRequestSettings(configPathFor(ctx)).enabled) {
          return { ok: false, error: "Requests are off, so nothing would hand it back. Turn them on (agentx requests settings --enabled on), or answer no to drop it." }
        }
        store.requestPickup(ref, now)
        return { ok: true, message: `${key}: ${r.agentId} will be asked to pick it up again` }
      }
      store.close(ref, "dropped", opts.note?.trim() || `dropped by ${by}`, now)
      return { ok: true, message: `${key}: dropped` }
    }
  }
}
