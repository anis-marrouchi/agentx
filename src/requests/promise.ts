import { randomBytes } from "crypto"
import { parseEvidence, type Evidence } from "@/requests/evidence"
import type { FactInput, WriteResult } from "@/wiki/facts/ledger"
import type { CloseWhen } from "./checkers"
import { parseRef } from "./checkers/issue"
import { OPEN_STATES, OWED_TO_OWNER, type LinkKind, type RequestHome, type RequestRecord, type RequestStore } from "./store"

// --- One Promise, proof that leaves a Fact (#1138 step D) ---
//
// A promise is an open loop in the request store: who owes it (an agent,
// or the owner), who waits on it, when it is due, and what closes it.
// Every path that follows work someone owes opens and raises its loop here:
//
//   openPromise   the one way to open one: an agent's promise (action
//                 promise), a decision card (owed by the owner), a task
//                 watcher's task that nobody else follows
//   raiseLoop     the one escalation: the loop needs attention, and the
//                 requests check tells the owner once (sweep.ts)
//   waitOnLoop    handed work that ends to wait (#1100) leaves its request
//                 open, waiting, due when the wait should end
//
// "Done" carries a Proof of one of four kinds: a link, a test run, an
// output, or a check that ran. Closing a promise with one writes a checked
// fact to the wiki fact ledger (source, checked-at, expiry), so "is X
// done?" has a dated answer in `agentx wiki facts list`. A done without a
// proof closes as before and leaves no fact.

export const PROOF_KINDS = ["link", "test", "output", "check"] as const
export type ProofKind = (typeof PROOF_KINDS)[number]

export interface Proof {
  kind: ProofKind
  /** The link, the test command, the output, or what the check found. */
  value: string
  /** When the proof was made (the test ran, the check ran), epoch ms. */
  ranAt: number
  /** A test run's counts. */
  passed?: number
  failed?: number
}

const VALUE_MAX = 500

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")

/** A test run proves something only when a test passed and none failed. */
function testProblem(passed: number, failed: number): string | null {
  if (failed > 0) return `a test proof needs every test to pass: ${failed} failed`
  if (passed < 1) return "a test proof needs at least one passed test"
  return null
}

/** When it ran: epoch ms or an ISO date, never after `now`. Unset: now. */
function ranAtOf(v: unknown, now: number): number | string {
  if (v === undefined || v === null || v === "") return now
  const at = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN
  if (!Number.isFinite(at) || at <= 0) return "proof.ranAt must be an ISO date or epoch milliseconds"
  return Math.min(at, now)
}

/** The watcher's evidence (#1049) as a proof. A test run that failed is not one. */
export function proofFromEvidence(ev: Evidence, ranAt: number): Proof | null {
  if (ev.type === "link") return { kind: "link", value: ev.url.slice(0, VALUE_MAX), ranAt }
  if (ev.type === "output") return { kind: "output", value: ev.text.slice(0, VALUE_MAX), ranAt }
  if (testProblem(ev.passed, ev.failed)) return null
  return { kind: "test", value: (ev.command || `${ev.passed} passed`).slice(0, VALUE_MAX), ranAt, passed: ev.passed, failed: ev.failed }
}

/** Reads the `proof` of a done. Accepted:
 *    "https://…"                                   a link
 *    {kind:"link", url}                            a link
 *    {kind:"test", passed, failed, command?}       a passing test run
 *    {kind:"output", text}                         what the work produced
 *    {kind:"check", value, ranAt?}                 a check that ran, and what it found
 *  `type` is read like `kind`, so the watchers' evidence objects pass too.
 *  Null: none given. A string: why it is not a proof. */
export function parseProof(raw: unknown, now: number): Proof | null | string {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw === "string") {
    const ev = parseEvidence(raw)
    if (typeof ev === "string") return ev
    if (!ev || ev.type !== "link") return 'a proof given as text must be a link (http or https); otherwise give {kind:"output", text}'
    return proofFromEvidence(ev, now)
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return "proof must be a link or an object with a kind"
  const o = raw as Record<string, unknown>
  const kind = str(o.kind ?? o.type).toLowerCase()
  if (!(PROOF_KINDS as readonly string[]).includes(kind)) return `proof.kind must be one of ${PROOF_KINDS.join(", ")}`
  const ranAt = ranAtOf(o.ranAt, now)
  if (typeof ranAt === "string") return ranAt
  if (kind === "check") {
    const value = str(o.value ?? o.detail)
    if (!value) return "a check proof needs value: the check that ran and what it found"
    return { kind: "check", value: value.slice(0, VALUE_MAX), ranAt }
  }
  // link, test and output read like the watchers' evidence (#1049).
  const ev = parseEvidence({ ...o, type: kind, url: o.url ?? o.value, text: o.text ?? o.value })
  if (typeof ev === "string") return ev
  if (!ev) return "proof is empty"
  if (ev.type === "test") {
    const why = testProblem(ev.passed, ev.failed)
    if (why) return why
  }
  return proofFromEvidence(ev, ranAt)
}

/** The proof in one line, for the evidence column and a fact's source. */
export function describeProof(p: Proof): string {
  if (p.kind === "test") return `test: ${p.value} (${p.passed ?? 0} passed, ${p.failed ?? 0} failed)`
  return `${p.kind}: ${p.value}`
}

// ── Settings ──────────────────────────────────────────────────────────────

export interface PromiseSettings {
  /** An agent's done on a promise needs a proof: a link, a passing test
   *  run, an output, or a check that ran. Off: any evidence closes it. */
  requireProof: boolean
  /** Closing a promise with a proof writes a checked fact to the wiki. */
  facts: boolean
  /** Days such a fact stays trusted before it counts as stale. */
  factTtlDays: number
  /** A decision card raised outside a request's turn opens a promise owed
   *  by the owner, closed when the card is decided. */
  cards: boolean
  /** A promise that falls due and is not kept is pushed by the requests
   *  check: agent woken, waiter told, needs attention (#1908). */
  duePush: boolean
  /** A due time an agent accepts on a request arms a wake-up (#1908). */
  acceptWake: boolean
}

export const DEFAULT_PROMISE_SETTINGS: PromiseSettings = { requireProof: true, facts: true, factTtlDays: 7, cards: false, duePush: true, acceptWake: true }

export const promiseSettingsOf = (s: { promises?: Partial<PromiseSettings> } | undefined): PromiseSettings => ({ ...DEFAULT_PROMISE_SETTINGS, ...s?.promises })

/** Why an agent's done on this request is refused: a promise closes only
 *  with a proof (#1138 D). Null: it may close. */
export function proofRefusal(r: Pick<RequestRecord, "id" | "promise">, proof: Proof | null, settings: PromiseSettings): string | null {
  if (!r.promise || proof || !settings.requireProof) return null
  return `Not closed: promise ${r.id} closes as done only with a proof. Give proof as one of: a link (evidence "https://…" or {kind:"link", url}), ` +
    `a passing test run {kind:"test", passed:<n>, failed:0, command}, an output {kind:"output", text}, or a check that ran {kind:"check", value}.`
}

// ── Opening and raising loops ─────────────────────────────────────────────

export interface OpenPromiseInput {
  /** The agent that holds it: it does the work, or acts on the owner's answer. */
  agentId: string
  /** Who waits on it: "owner", an agent id, or a known person id. */
  owedTo: string
  /** Who owes it, when not `agentId`: "owner" for a decision card. */
  owedBy?: string
  /** What is promised, in a sentence. */
  text: string
  /** The chat of the turn that made it (where the agent answers). */
  channel: string
  chatId: string
  dueAt?: number | null
  closeWhen?: CloseWhen | null
  home?: RequestHome | null
  /** What it follows (a card), so its end finds it. */
  link?: { kind: LinkKind; ref: string }
  headline?: string
  /** False: its due time does not wake the agent (an escalation). */
  wake?: boolean
  now: number
}

const ITEM_LINK = /https?:\/\/[^\s<>()"'`]+?\/(?:-\/(?:issues|merge_requests)|issues|pull)\/\d+(?![\w/])/

/** "group/project#12" or "group/project!12" in running words. */
const SHORT_REF = /(?<![\w/.:@-])([\w-][\w.-]*(?:\/[\w-][\w.-]*)+)([#!])(\d+)(?!\w)/
/** "issue 877", "MR 12", "PR 12": a number in the chat's own project. A
 *  lone "#2" / "!2" is not read: promise words say "point #2" or "step #5"
 *  far more often than they mean an issue, and a wrong checker would stop
 *  the agent closing its own promise (daemon-api "done" needs it met). */
const BARE_REF = /\b(issue|mr|merge request|pr|pull request)\s+#?(\d+)(?!\w)/i

type Forge = "github" | "gitlab"

/** Where the promise was made, so a short ref finds its forge and a bare
 *  number its project (noqta#876 step 5). */
export interface IssueRefContext {
  channel?: string
  /** A forge chat: "group/project:issue:12" (GitLab), "owner/repo:pull:3" (GitHub). */
  chatId?: string
  /** The forge a short "group/project#12" means outside a forge chat:
   *  the one this node is set up for. Null: none. */
  forge?: Forge | null
}

function chatProject(ctx: IssueRefContext): { provider: Forge; project: string } | null {
  if (ctx.channel !== "gitlab" && ctx.channel !== "github") return null
  const m = (ctx.chatId ?? "").match(/^(.+?):[a-z_]+:\d+$/)
  return m ? { provider: ctx.channel, project: m[1] } : null
}

/** The issue or merge request the words name, as a ref the checker reads:
 *  a web address first, then "group/project#12", then a bare number in a
 *  forge chat's project. Null when they name none this node can read. */
function itemRef(text: string, ctx: IssueRefContext): { provider: Forge; ref: string } | null {
  const m = text.match(ITEM_LINK)
  if (m) {
    const link = m[0].replace(/[.,;:]+$/, "")
    let host: string
    try { host = new URL(link).hostname.toLowerCase() } catch { return null }
    const provider = host === "github.com" ? "github" : "gitlab"
    return parseRef(provider, link) ? { provider, ref: link } : null
  }
  const chat = chatProject(ctx)
  const s = text.match(SHORT_REF)
  if (s) {
    // "!" is a GitLab merge request; "#" is the forge of the chat, else the node's.
    const provider: Forge | null = s[2] === "!" ? "gitlab" : chat?.provider ?? ctx.forge ?? null
    const ref = `${s[1]}${s[2]}${s[3]}`
    return provider && parseRef(provider, ref) ? { provider, ref } : null
  }
  const b = text.match(BARE_REF)
  if (b && chat) {
    const word = b[1].toLowerCase()
    const mr = word !== "issue"
    // GitHub reads issues and pull requests by "#"; GitLab merge requests by "!".
    const ref = `${chat.project}${mr && chat.provider === "gitlab" ? "!" : "#"}${b[2]}`
    return parseRef(chat.provider, ref) ? { provider: chat.provider, ref } : null
  }
  return null
}

/** A checker for a promise whose words name an issue or merge request
 *  (noqta#876 cause 4, step 5): it closes when a note written after the
 *  promise opened carries the promise's id. Not on the item's state: an
 *  item already closed or merged would close the promise at its first
 *  check, and a merged MR is not a later deploy. The words may give the
 *  item's address, a short "group/project#12", or, in a forge chat, a
 *  bare "issue 12". Null when they name none, or none the checker reads. */
export function issueCloseWhen(text: string, id: string, now: number, ctx: IssueRefContext = {}): CloseWhen | null {
  const item = itemRef(text, ctx)
  return item ? { kind: "issue", provider: item.provider, ref: item.ref, notePattern: id, after: now } : null
}

/** Opens a promise and returns it. The one way to open one (#1138 D):
 *  owed by the owner it waits on the owner from the start. */
export function openPromise(store: RequestStore, input: OpenPromiseInput): RequestRecord {
  const id = `prm-${input.now.toString(36)}-${randomBytes(3).toString("hex")}`
  const byOwner = input.owedBy === OWED_TO_OWNER
  store.addPromise({
    id, channel: input.channel, chatId: input.chatId, agentId: input.agentId, text: input.text, owedTo: input.owedTo,
    owedBy: input.owedBy ?? null, dueAt: input.dueAt ?? null, closeWhen: input.closeWhen ?? null, home: input.home ?? null, now: input.now,
  })
  if (input.link) store.link(id, input.link.kind, input.link.ref, input.now)
  if (byOwner) store.waitOnOwner(id, input.text, input.now)
  if (input.headline) store.setHeadline(id, { headline: input.headline }, "agent")
  if (!byOwner && input.wake !== false) armPromiseWake(store, id, input.dueAt ?? null, input.now)
  return store.get(id)!
}

/** The brick noqta#858 found missing: a due time only told the owner the
 *  promise was late. Now the agent that owes it is woken when it falls
 *  due, through the job wake. Not a due time already past (the agent is
 *  in the turn that made it) nor one the owner owes (the owner is not
 *  an agent to wake). */
export function armPromiseWake(store: RequestStore, id: string, dueAt: number | null, now: number): boolean {
  if (dueAt === null || dueAt <= now) return false
  const r = store.get(id)
  if (!r || r.owedBy === OWED_TO_OWNER) return false
  const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
  return store.armDueWake(id, dueAt, `It is due now (${new Date(dueAt).toISOString()}), owed to ${r.owedTo ?? "the owner"}: ${words}`, now)
}

/** The one escalation (#1138 D): the loop that follows this work needs
 *  attention, and the requests check tells the owner once. The work's own
 *  request when one follows it (any of `links`); else a promise of the
 *  agent's own, owed to `owedTo`, linked by `link`. */
export function raiseLoop(
  store: RequestStore,
  input: { links: Array<{ kind: LinkKind; ref: string }>; reason: string; open: Omit<OpenPromiseInput, "now"> & { link: { kind: LinkKind; ref: string } }; now: number },
): { requestId: string; raised: boolean; opened: boolean } {
  for (const l of [input.open.link, ...input.links]) {
    const r = store.byLink(l.kind, l.ref)
    // A candidate is the owner's turn still running past its due time: it is theirs.
    if (r && (r.state === "candidate" || (OPEN_STATES as readonly string[]).includes(r.state))) {
      // Linked, so the loop's own close and notice find it too.
      if (l !== input.open.link) store.link(r.id, input.open.link.kind, input.open.link.ref, input.now)
      return { requestId: r.id, raised: store.needsAttention(r.id, input.reason, input.now), opened: false }
    }
  }
  // It needs attention now: a wake would hide that behind 'continue'.
  const r = openPromise(store, { ...input.open, wake: false, now: input.now })
  return { requestId: r.id, raised: store.needsAttention(r.id, input.reason, input.now), opened: true }
}

/** Work handed on ended its run to wait for something (#1100): the request
 *  waits on it, and is due when the wait should end, so a wait that runs
 *  out comes back through the one escalation (the requests check's
 *  overdue loop) and not a path of its own. A due time the request
 *  already has is kept. Null when there is no open request. */
export function waitOnLoop(store: RequestStore, requestId: string | null, wait: { dueAt?: number | null }, now: number): RequestRecord | null {
  if (!requestId) return null
  const r = store.get(requestId)
  if (!r || !(OPEN_STATES as readonly string[]).includes(r.state)) return null
  if (r.state === "waiting_owner") return r
  store.progress(r.id, now, "waiting_other")
  if (wait.dueAt && r.dueAt === null) store.setLoop(r.id, { dueAt: wait.dueAt }, now)
  return store.get(r.id)
}

// ── The fact a kept promise leaves ────────────────────────────────────────

export interface FactWriter {
  write(input: FactInput, opts?: { now?: number }): WriteResult
}

/** The fact a promise closed with a proof leaves: its headline (or its
 *  words) is done, checked by the proof, trusted for factTtlDays. One the
 *  owner owed (a decision card) records the owner's answer instead. */
export function promiseFact(r: RequestRecord, proof: Proof, settings: PromiseSettings): FactInput {
  const words = (r.headline ?? r.text).replace(/\s+/g, " ").trim()
  const byOwner = r.owedBy === OWED_TO_OWNER
  return {
    subject: words.length > 120 ? `${words.slice(0, 119)}…` : words,
    attribute: byOwner ? "owner's answer" : "done",
    value: byOwner ? proof.value.slice(0, 200) : "yes",
    source: `${describeProof(proof)} (${r.id})`.slice(0, 600),
    verifiedBy: r.owedBy === OWED_TO_OWNER ? OWED_TO_OWNER : r.agentId,
    verifiedAt: new Date(proof.ranAt).toISOString(),
    volatility: "work-state",
    ttlDays: settings.factTtlDays,
  }
}

/** After every close as done: a promise with a proof leaves its fact, and
 *  the request keeps the fact's id. Never throws into the closing path. */
export function attachPromiseFacts(
  store: RequestStore,
  deps: { settings: () => PromiseSettings; ledger: () => FactWriter | null; log: (msg: string) => void; now?: () => number },
): () => void {
  return store.onDone((r) => {
    try {
      const settings = deps.settings()
      if (!r.promise || !r.proof || !settings.facts) return
      const ledger = deps.ledger()
      if (!ledger) return
      const w = ledger.write(promiseFact(r, r.proof, settings), { now: deps.now?.() })
      store.setFact(r.id, w.fact.id)
      deps.log(`[requests] ${r.id}: fact ${w.fact.id} ${w.status} (${describeProof(r.proof)})`)
    } catch (e: any) {
      deps.log(`[requests] ${r.id}: could not write its fact: ${e?.message ?? e}`)
    }
  })
}
