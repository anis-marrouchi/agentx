import type Database from "better-sqlite3"
import { hasRequestTables, OPEN_STATES } from "./store"
import { OPERATOR_CHANNELS } from "./tracker"
import { delegationIdOfChat } from "@/a2a/delegation"
import { IMPLICIT_OWNER } from "@/people/people"

// --- The hand-back contract, measured (#1509 step 0) ---
//
// What an agent owes the person when it delivers or goes quiet, and how
// well agents meet it today. Five numbers, per agent and for the node,
// read from the store the daemon writes:
//
//   chain coverage   a2a turns whose chat traces back to a request
//   delivery reach   outputs in a request's chain the owner was told of,
//                    with a link, within N minutes
//   openable proof   requests closed done whose proof is a link
//   quiet breaches   open requests with no owner-visible change for their
//                    rhythm, and no status line written for them
//   status pulls     owner turns that ask what is going on
//
// Beside them, what steps 1–3 would have written (the dry run): the
// request each nested hop would inherit, the outputs that would land on
// a request, and the status line of each quiet request. Read only: this
// file never writes, never calls a model, never tells anyone.

export interface ContractOptions {
  since: number
  until: number
  /** An output counts as delivered when the owner was told within this. */
  deliverWithinMinutes: number
  /** An open request with no owner-visible change for this long is quiet. */
  rhythmHours: number
  /** Past this, step 3 would also push the status line. */
  pushAfterHours: number
  /** Known people with the owner role. "owner" is always one. */
  ownerIds?: string[]
  /** Only this agent's turns and requests. */
  agent?: string
  /** Rows kept in each dry-run list. */
  sample?: number
}

export interface Ratio { n: number; of: number }

export interface AgentContract {
  agent: string
  turns: number
  a2aTurns: number
  /** a2a turns whose chat is linked to a request today (first hop only). */
  linkedTurns: number
  /** a2a turns that would trace back to a request once step 1 is on. */
  chainTurns: number
  outputs: number
  pathOnlyOutputs: number
  told: number
}

export interface DryOutput { requestId: string; agent: string; at: number; output: string; kind: "link" | "path"; reached: boolean }
export interface DryQuiet { requestId: string; agent: string; state: string; quietHours: number; push: boolean; line: string }
export interface DryHop { chat: string; agent: string; requestId: string; via: string }

export interface ContractReport {
  since: number
  until: number
  settings: Pick<ContractOptions, "deliverWithinMinutes" | "rhythmHours" | "pushAfterHours">
  turnsByChannel: Record<string, number>
  chain: { turns: Ratio; chats: Ratio; inherited: { turns: Ratio; chats: Ratio } }
  delivery: { outputs: number; withPath: number; pathOnly: number; inChain: number; reached: Ratio }
  proof: { closedDone: number; link: number; path: number; other: number; none: number; dropped: number; toldAtClose: Ratio }
  quiet: { open: number; breaches: number; pushes: number }
  pulls: { ownerTurns: number; pulls: number; byDay: Record<string, number> }
  told: { rows: number; seen: number; outcomes: Record<string, number> }
  agents: AgentContract[]
  dryRun: { hops: DryHop[]; outputs: DryOutput[]; quiet: DryQuiet[] }
}

/** Channels whose turns can deliver work: a2a, plan steps, tools, workflows. */
const OUTPUT_CHANNELS: ReadonlySet<string> = new Set(["a2a", "requests", "mcp", "workflow"])

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi
const HAS_LINK = /https?:\/\//i
/** A local path: absolute, home-relative, or a relative one with a folder
 *  and a file or a trailing slash. Read after links are taken out. */
const PATH_RE = /(?:^|[\s`'"(\[])((?:~|\.{1,2})?\/(?:[\w.@-]+\/)*[\w.@-]+\/?|[\w.@-]+\/(?:[\w.@-]+\/)*(?:[\w@-]+\.[A-Za-z0-9]{1,8}|[\w.@-]*\/))(?=$|[\s`'")\],;:])/g

/** The links and local paths an answer names. */
export function outputsOf(text: string | null | undefined): { links: string[]; paths: string[] } {
  if (!text) return { links: [], paths: [] }
  const links = [...text.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?*_]+$/, ""))
  const rest = text.replace(URL_RE, " ")
  const paths = [...rest.matchAll(PATH_RE)].map((m) => m[1])
    // "and/or", "1/2", a lone "/": words, not paths.
    .filter((p) => p.length > 3 && /[A-Za-z]/.test(p) && !/^[A-Za-z]+\/[A-Za-z]+$/.test(p))
  return { links: [...new Set(links)], paths: [...new Set(paths)] }
}

/** Owner words that ask where work stands. A keyword match: a lower bound. */
const PULL_RE = /\b(what( is| are|'s) ([\w-]+ ){1,3}(doing|working on|up to)|where (is|are) (it|the|my|we|this|that)|any (update|news|progress)|status (of|on)|is (he|she|it|they) (still |right now |now )?(working|on it|done)|last session|how far|did (it|he|she|they) (finish|deliver|land))\b/i

export function isStatusPull(text: string | null | undefined): boolean {
  return !!text && PULL_RE.test(text)
}

const HOUR = 3_600_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z"
const ratio = (n: number, of: number): Ratio => ({ n, of })

interface Trace {
  id: string; agent: string; channel: string; chat: string; person: string | null
  start: number; end: number | null; message: string | null; response: string | null
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name))
}

/** Measure the contract over [since, until). */
export function measureContract(db: Database.Database, opts: ContractOptions): ContractReport {
  const { since, until } = opts
  const sample = opts.sample ?? 20
  const owners = new Set([IMPLICIT_OWNER, ...(opts.ownerIds ?? [])])
  const withRequests = hasRequestTables(db)
  const withTold = hasTable(db, "owner_told")

  // Turns: the window, plus a day before it, so a hop in the window can
  // find the turn that started it.
  const traceCols = hasTable(db, "task_traces") ? columns(db, "task_traces") : new Set<string>()
  const col = (name: string, fallback = "NULL") => (traceCols.has(name) ? name : fallback)
  const traces: Trace[] = traceCols.size
    ? (db.prepare(
      `SELECT task_id, agent_id, COALESCE(channel, '') AS channel, COALESCE(chat_id, '') AS chat_id, ${col("person")} AS person,
              started_at, finished_at, substr(COALESCE(${col("original_message")}, message_preview), 1, 2000) AS message,
              substr(${col("final_response")}, 1, 8000) AS response
         FROM task_traces WHERE started_at >= ? AND started_at < ? ORDER BY started_at`,
    ).all(since - 24 * HOUR, until) as any[]).map((r) => ({
      id: r.task_id, agent: r.agent_id, channel: r.channel, chat: r.chat_id, person: r.person ?? null,
      start: r.started_at, end: r.finished_at ?? null, message: r.message ?? null, response: r.response ?? null,
    }))
    : []
  const inWindow = (t: Trace) => t.start >= since && (!opts.agent || t.agent === opts.agent)

  // Links: a turn's run, and a delegation's chat, to their request.
  const runOf = new Map<string, string>()
  const dlgOf = new Map<string, string>()
  const reqs = new Map<string, any>()
  if (withRequests) {
    for (const l of db.prepare("SELECT request_id, kind, ref FROM request_links WHERE kind IN ('run', 'step_run', 'delegation')").all() as any[]) {
      if (l.kind === "delegation") dlgOf.set(l.ref, l.request_id)
      else runOf.set(l.ref, l.request_id)
    }
    for (const r of db.prepare("SELECT * FROM requests WHERE state != 'candidate' AND (closed_at IS NULL OR closed_at >= ?)").all(since - 24 * HOUR) as any[]) reqs.set(r.id, r)
  }
  // The request open in a chat at a time: a callback turn in the owner's
  // chat belongs to the request its delegation was linked to.
  const byChat = new Map<string, any[]>()
  for (const r of reqs.values()) {
    const k = `${r.agent_id}\u0000${r.channel}\u0000${r.chat_id}`
    byChat.set(k, [...(byChat.get(k) ?? []), r])
  }
  const openInChat = (t: Trace): string | null => {
    const list = byChat.get(`${t.agent}\u0000${t.channel}\u0000${t.chat}`) ?? []
    const hit = list.filter((r) => r.created_at <= t.start && (r.closed_at == null || r.closed_at >= t.start)).sort((a, b) => b.created_at - a.created_at)[0]
    return hit?.id ?? null
  }

  const byAgent = new Map<string, Trace[]>()
  const firstInChat = new Map<string, Trace>()
  for (const t of traces) {
    byAgent.set(t.agent, [...(byAgent.get(t.agent) ?? []), t])
    if (!firstInChat.has(t.chat)) firstInChat.set(t.chat, t)
  }

  // Today: a turn belongs to a request through its run, its chat's
  // delegation (first hop only), or the request open in its chat.
  const linkedNow = (t: Trace): string | null => {
    const run = runOf.get(t.id)
    if (run) return run
    const dlg = delegationIdOfChat(t.chat)
    if (dlg) return dlgOf.get(dlg) ?? null
    return openInChat(t)
  }
  // Step 1: a hop with no link inherits the request of the caller's turn
  // that was running when the hop started. Bounded, and remembered.
  const inherited = new Map<string, { id: string | null; via: string }>()
  const chainOf = (t: Trace, depth = 0): { id: string | null; via: string } => {
    const now = linkedNow(t)
    if (now) return { id: now, via: "linked" }
    const known = inherited.get(t.chat)
    if (known) return known
    const dlg = delegationIdOfChat(t.chat)
    if (!dlg || depth > 8) return { id: null, via: "none" }
    const caller = t.chat.split(":")[1]
    const first = firstInChat.get(t.chat) ?? t
    const parent = (byAgent.get(caller) ?? [])
      .filter((p) => p.start <= first.start && (p.end == null || p.end >= first.start) && p.chat !== t.chat)
      .sort((a, b) => b.start - a.start)[0]
    const out = parent ? { ...chainOf(parent, depth + 1), via: `${caller}` } : { id: null, via: "none" }
    inherited.set(t.chat, out)
    return out
  }

  // Told rows in the window, by request and by sender.
  const told: any[] = withTold
    ? db.prepare("SELECT * FROM owner_told WHERE at >= ? AND at < ? ORDER BY at").all(since, until + opts.deliverWithinMinutes * 60_000) as any[]
    : []
  const toldIn = told.filter((r) => r.at < until)
  const toldByRequest = new Map<string, any[]>()
  for (const r of told) if (r.request_id) toldByRequest.set(r.request_id, [...(toldByRequest.get(r.request_id) ?? []), r])

  const report: ContractReport = {
    since, until,
    settings: { deliverWithinMinutes: opts.deliverWithinMinutes, rhythmHours: opts.rhythmHours, pushAfterHours: opts.pushAfterHours },
    turnsByChannel: {},
    chain: { turns: ratio(0, 0), chats: ratio(0, 0), inherited: { turns: ratio(0, 0), chats: ratio(0, 0) } },
    delivery: { outputs: 0, withPath: 0, pathOnly: 0, inChain: 0, reached: ratio(0, 0) },
    proof: { closedDone: 0, link: 0, path: 0, other: 0, none: 0, dropped: 0, toldAtClose: ratio(0, 0) },
    quiet: { open: 0, breaches: 0, pushes: 0 },
    pulls: { ownerTurns: 0, pulls: 0, byDay: {} },
    told: { rows: toldIn.length, seen: 0, outcomes: {} },
    agents: [],
    dryRun: { hops: [], outputs: [], quiet: [] },
  }
  const agents = new Map<string, AgentContract>()
  const agentRow = (id: string) => {
    let a = agents.get(id)
    if (!a) agents.set(id, (a = { agent: id, turns: 0, a2aTurns: 0, linkedTurns: 0, chainTurns: 0, outputs: 0, pathOnlyOutputs: 0, told: 0 }))
    return a
  }
  const chats = { all: new Set<string>(), linked: new Set<string>(), chain: new Set<string>() }
  const lastOutput = new Map<string, { at: number; output: string }>()
  const lastTurn = new Map<string, Trace>()

  for (const t of traces) {
    if (!inWindow(t)) continue
    const a = agentRow(t.agent)
    a.turns++
    report.turnsByChannel[t.channel || "unknown"] = (report.turnsByChannel[t.channel || "unknown"] ?? 0) + 1
    const chain = chainOf(t)
    if (chain.id) lastTurn.set(chain.id, t)

    if (t.channel === "a2a") {
      a.a2aTurns++
      chats.all.add(t.chat)
      if (linkedNow(t)) { a.linkedTurns++; chats.linked.add(t.chat) }
      if (chain.id) {
        a.chainTurns++
        chats.chain.add(t.chat)
        if (chain.via !== "linked" && !report.dryRun.hops.some((h) => h.chat === t.chat) && report.dryRun.hops.length < sample) {
          report.dryRun.hops.push({ chat: t.chat, agent: t.agent, requestId: chain.id, via: chain.via })
        }
      }
    }

    // Outputs: a turn that names a link or a local path.
    if (OUTPUT_CHANNELS.has(t.channel) && t.end != null) {
      const { links, paths } = outputsOf(t.response)
      if (links.length || paths.length) {
        report.delivery.outputs++
        a.outputs++
        if (paths.length) report.delivery.withPath++
        if (paths.length && !links.length) { report.delivery.pathOnly++; a.pathOnlyOutputs++ }
        if (chain.id) {
          report.delivery.inChain++
          const deadline = t.end + opts.deliverWithinMinutes * 60_000
          const reached = (toldByRequest.get(chain.id) ?? []).some((r) => r.at >= t.end! && r.at <= deadline && r.outcome !== "failed" && HAS_LINK.test(`${r.title}\n${r.text}`))
          report.delivery.reached.of++
          if (reached) report.delivery.reached.n++
          const output = links[0] ?? paths[0]
          if ((lastOutput.get(chain.id)?.at ?? -1) <= t.end) lastOutput.set(chain.id, { at: t.end, output })
          if (report.dryRun.outputs.length < sample) {
            report.dryRun.outputs.push({ requestId: chain.id, agent: t.agent, at: t.end, output, kind: links.length ? "link" : "path", reached })
          }
        }
      }
    }

    // Owner turns, and those that ask where things stand.
    const ownerTurn = (t.person != null && owners.has(t.person))
      || (t.person == null && OPERATOR_CHANNELS.has(t.channel.toLowerCase()))
      || (runOf.has(t.id) && reqs.get(runOf.get(t.id)!)?.promise !== 1)
    if (ownerTurn && t.channel !== "a2a") {
      report.pulls.ownerTurns++
      if (isStatusPull(t.message)) {
        report.pulls.pulls++
        report.pulls.byDay[dayOf(t.start)] = (report.pulls.byDay[dayOf(t.start)] ?? 0) + 1
      }
    }
  }
  report.chain.turns = ratio([...agents.values()].reduce((s, a) => s + a.linkedTurns, 0), [...agents.values()].reduce((s, a) => s + a.a2aTurns, 0))
  report.chain.chats = ratio(chats.linked.size, chats.all.size)
  report.chain.inherited.turns = ratio([...agents.values()].reduce((s, a) => s + a.chainTurns, 0), report.chain.turns.of)
  report.chain.inherited.chats = ratio(chats.chain.size, chats.all.size)

  for (const r of toldIn) {
    report.told.outcomes[r.outcome] = (report.told.outcomes[r.outcome] ?? 0) + 1
    if (r.seen_at != null) report.told.seen++
    if (r.sender && (!opts.agent || r.sender === opts.agent)) agentRow(r.sender).told++
  }

  // Proof on close, and whether the owner was told at or after it.
  for (const r of reqs.values()) {
    if (r.closed_at == null || r.closed_at < since || r.closed_at >= until) continue
    if (opts.agent && r.agent_id !== opts.agent) continue
    if (r.state === "dropped") report.proof.dropped++
    report.proof.toldAtClose.of++
    if ((toldByRequest.get(r.id) ?? []).some((t) => t.at >= r.closed_at && t.outcome !== "failed")) report.proof.toldAtClose.n++
    if (r.state !== "done") continue
    report.proof.closedDone++
    let value: string | null = r.evidence ?? null
    if (!value && r.proof) { try { value = JSON.parse(r.proof)?.value ?? null } catch { /* unreadable: none */ } }
    if (!value?.trim()) report.proof.none++
    else {
      const o = outputsOf(value)
      if (o.links.length) report.proof.link++
      else if (o.paths.length) report.proof.path++
      else report.proof.other++
    }
  }

  // Quiet: open requests whose last owner-visible change is past the
  // rhythm. Nothing writes a status line yet, so each one is a breach.
  for (const r of reqs.values()) {
    if (!(OPEN_STATES as readonly string[]).includes(r.state)) continue
    if (opts.agent && r.agent_id !== opts.agent) continue
    report.quiet.open++
    const lastTold = (toldByRequest.get(r.id) ?? []).reduce((m, t) => Math.max(m, t.at), 0)
    const changed = Math.max(r.state_changed_at ?? r.updated_at ?? r.created_at, lastTold)
    const quietMs = until - changed
    if (quietMs < opts.rhythmHours * HOUR) continue
    report.quiet.breaches++
    const push = quietMs >= opts.pushAfterHours * HOUR
    if (push) report.quiet.pushes++
    if (report.dryRun.quiet.length < sample) {
      report.dryRun.quiet.push({ requestId: r.id, agent: r.agent_id, state: r.state, quietHours: Math.round(quietMs / HOUR * 10) / 10, push, line: statusLine(db, r, lastTurn.get(r.id) ?? null, lastOutput.get(r.id) ?? null) })
    }
  }

  report.agents = [...agents.values()].sort((a, b) => b.a2aTurns - a.a2aTurns || b.turns - a.turns)
  return report
}

/** The line step 3 would write on a quiet request, from traces and links
 *  only: last turn, what it waits on, last output. */
export function statusLine(db: Database.Database, r: any, last: { agent: string; start: number } | null, output: { at: number; output: string } | null): string {
  const parts: string[] = []
  parts.push(last ? `last turn ${hhmm(last.start)} by ${last.agent}` : `no turn in the window`)
  if (r.state === "waiting_owner") parts.push(`waiting on you${r.question ? `: ${String(r.question).replace(/\s+/g, " ").slice(0, 80)}` : ""}`)
  else {
    const open = db.prepare("SELECT ref, at FROM request_links WHERE request_id = ? AND kind = 'delegation' AND ended IS NULL ORDER BY at").all(r.id) as Array<{ ref: string; at: number }>
    if (open.length) parts.push(`waiting on ${open.length} hand-off(s) since ${hhmm(open[0].at)}`)
    else if (r.state === "needs_attention") parts.push(`needs attention${r.attention_reason ? `: ${String(r.attention_reason).slice(0, 80)}` : ""}`)
    else parts.push(`with ${r.agent_id}`)
  }
  parts.push(output ? `last output ${output.output} at ${hhmm(output.at)}` : "no output yet")
  return parts.join(" · ")
}

/** "7d", "36h", "90m": a span in ms. Null when it does not read. */
export function parseSpan(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(s.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toLowerCase() === "d" ? 24 * HOUR : m[2].toLowerCase() === "h" ? HOUR : 60_000
  return n > 0 ? n * unit : null
}

export const pct = (r: Ratio): string => (r.of ? `${Math.round((r.n / r.of) * 100)} %` : "–")
