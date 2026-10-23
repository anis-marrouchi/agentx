import type Database from "better-sqlite3"
import { MAX_OPEN_PROMISES } from "./daemon-api"
import { HEADLINE_MAX } from "./headline"
import { openPromise } from "./promise"
import { OPEN_STATES, OWED_TO_OWNER, type RequestRecord, type RequestStore } from "./store"

// --- Catch "I'll do X" as a promise (#1138 step E) ---
//
// An agent that ends an owner's turn with "I'll send it at 18:00" made a
// promise nobody follows: the turn ended cleanly, so its request was
// dropped. Here one small model call reads the reply at the end of such a
// turn and says which of three it is:
//
//   promise         the agent itself will do a named thing later, with
//                   no condition left: it becomes a promise (promise.ts)
//                   owned by that agent, owed to whoever asked
//   waiting_owner   the work cannot go on without the owner's answer:
//                   the request waits on the owner, with the question
//   none            anything else: an offer, a plan that is already done,
//                   a step someone else owes, a conditional "if you want"
//
// A word match is not enough (about half of all replies hold "I'll" or
// "will", most of them conditional), so the decision is the model's. The
// word check only skips replies that cannot be either, to save calls.
// Every call is recorded (request_catches): the daily cap counts them,
// and the record shows how many promises a day are caught.

export const CATCH_KINDS = ["promise", "waiting_owner", "none"] as const
export type CatchKind = (typeof CATCH_KINDS)[number]

export interface CatchVerdict {
  kind: CatchKind
  /** What is promised, in a short sentence (promise). */
  what: string | null
  /** When it is due, epoch ms (promise). Null: no time was said. */
  dueAt: number | null
  /** What the owner is asked (waiting_owner). */
  question: string | null
}

export interface CatchSettings {
  enabled: boolean
  /** Model calls per day (UTC), across all agents. */
  dailyCap: number
  /** A reply that asks the owner moves its request to waiting_owner. Off:
   *  only promises are caught. */
  waitingOwner: boolean
  provider?: string
  model?: string
  timeoutSeconds: number
}

export const DEFAULT_CATCH_SETTINGS: CatchSettings = { enabled: false, dailyCap: 300, waitingOwner: true, timeoutSeconds: 30 }

export const catchSettingsOf = (s: { catchPromises?: Partial<CatchSettings> } | undefined): CatchSettings => ({ ...DEFAULT_CATCH_SETTINGS, ...s?.catchPromises })

const REPLY_MAX = 4000
const WHAT_MAX = 300
const DAY = 24 * 60 * 60 * 1000
/** A due time further out than this is not believed. */
const DUE_MAX = 60 * DAY

const flat = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "")

/** Words that a promise or a question to the owner cannot do without:
 *  a future ("I'll", "will", "going to", "tomorrow", "je vais"…) or a
 *  question. A reply with none is "none" without a call. */
const MAY_CATCH = new RegExp([
  String.raw`\?`,
  String.raw`\b(?:i|we)(?:'|’)ll\b`,
  String.raw`\b(?:will|shall|going to|gonna|about to)\b`,
  String.raw`\b(?:tomorrow|tonight|later|next|once|after|as soon as|when (?:it|the|they|ci|you))\b`,
  String.raw`\b(?:waiting (?:on|for)|need your|your (?:call|go|ok|yes|answer|decision|approval))\b`,
  String.raw`\b(?:je vais|on va|demain|dès que|j'attends)\b`,
].join("|"), "i")

/** Could this reply be a promise or a question to the owner? */
export function mayCatch(reply: string): boolean {
  return MAY_CATCH.test(reply)
}

/** `now` as an ISO date-time in this machine's zone, with its offset, so
 *  "at 18:00" in a reply reads as the owner's 18:00. */
export function localTime(now: number): string {
  const off = -new Date(now).getTimezoneOffset()
  const local = new Date(now + off * 60_000).toISOString().slice(0, 19)
  const abs = Math.abs(off)
  return `${local}${off < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

/** The system prompt of the call, shared with the offline eval. */
export const CATCH_SYSTEM = "You classify what an AI agent's reply leaves open. Respond with a single JSON object on one line. No prose, no code fences."

/** The model's prompt. The reply and the request are data, fenced. */
export function catchPrompt(input: { reply: string; asked?: string | null; now: number }): string {
  return [
    "An AI agent just ended its turn with the reply below, written to the person who asked it something.",
    "Decide what the reply leaves open. Exactly one of:",
    "",
    '- "promise": the agent itself commits to do a specific thing AFTER this reply, with no condition left on the person.',
    '  Examples: "I\'ll send the report at 18:00." "Deploying now, I\'ll confirm when it is live." "I\'ll check again tomorrow morning and tell you."',
    "  Telling the person later counts: \"Coder is on it, I'll tell you when it is live\" is a promise (to tell).",
    '- "waiting_owner": the work the person asked for cannot go on until they answer or act, and the reply asks them for it.',
    '  Examples: "Which account should I use?" "I need your OK before I send it." "Say yes and I\'ll publish it." "Your message was cut off, what was the second thing?"',
    '- "none": everything else. In particular:',
    "  - the work is done and the reply reports it;",
    '  - a closing question that only offers a next step once the asked work is done or answered ("Should I…?", "Do you want me to…?", "Shall I have X do…?"), unless the reply says the asked work is held until the answer;',
    '  - offers of more work beyond what was asked: "I can also…", "Want me to…?", "Should I also…?", "If you like, I\'ll…";',
    '  - conditionals that may never happen: "If it breaks, tell me and I\'ll fix it.";',
    "  - what another agent, a person or a system will do, when this agent commits to nothing after it;",
    "  - waiting on someone other than the person;",
    "  - vague intentions with no deliverable (\"I'll keep that in mind\");",
    "  - steps the agent is still doing inside this same turn.",
    "",
    "When the reply both promises and asks: if the promised work waits on the answer, it is waiting_owner; if it goes ahead anyway, it is promise.",
    "",
    `Now: ${localTime(input.now)} (the person's local time).`,
    ...(input.asked ? ["", "WHAT THE PERSON ASKED:", "```", input.asked.slice(0, 1000), "```"] : []),
    "",
    "THE AGENT'S REPLY:",
    "```",
    input.reply.slice(-REPLY_MAX),
    "```",
    "",
    "Return ONE JSON object on one line, no prose, no fences:",
    '{"kind":"promise"|"waiting_owner"|"none","quote":string|null,"what":string|null,"due":string|null,"question":string|null}',
    "- quote: for a promise, the reply's own sentence in which the agent commits, copied word for word. Else null.",
    '- what: for a promise, what the agent will do, in one short sentence starting with a verb ("Send the Q3 report"). Else null.',
    "- due: for a promise, when it is due as an ISO 8601 date-time, only if the reply says or clearly implies a time (\"at 18:00\", \"tomorrow\", \"in an hour\"). Else null.",
    "- question: for waiting_owner, what the person is asked, in one short sentence. Else null.",
  ].join("\n")
}

const FIRST_PERSON_FUTURE = /\b(?:i|we)(?:'|’)ll\b|\b(?:i|we) (?:will|shall)\b|\b(?:i'm|i am|we're|we are) going to\b|\bje vais\b/i
const CONDITIONAL = /\b(?:if|unless|in case)\b|\b(?:i|we) (?:can|could|would|might|may)\b/i
const squash = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim()

/** The quoted sentence is in the reply, and commits: first person, future, no condition. */
export function firmQuote(quote: string, reply: string): boolean {
  if (!quote) return false
  const q = squash(quote).replace(/^["“]|["”.]$/g, "")
  if (!q || !squash(reply).includes(q)) return false
  return FIRST_PERSON_FUTURE.test(q) && !CONDITIONAL.test(q)
}

/** The verdict in the model's answer, or null when it gave none that reads. */
export function readVerdict(text: string, now: number, reply: string): CatchVerdict | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  let parsed: any
  try { parsed = JSON.parse(m[0]) } catch { return null }
  const kind = flat(parsed?.kind).toLowerCase() as CatchKind
  if (!(CATCH_KINDS as readonly string[]).includes(kind)) return null
  if (kind === "none") return { kind, what: null, dueAt: null, question: null }
  if (kind === "waiting_owner") {
    const question = flat(parsed.question).slice(0, WHAT_MAX)
    return question ? { kind, what: null, dueAt: null, question } : null
  }
  const what = flat(parsed.what).slice(0, WHAT_MAX)
  if (!what) return null
  // A promise is only as firm as the sentence that makes it: the agent's
  // own, in the reply, in the first person and the future, with no "if".
  // Anything less is read as none, whatever the model said.
  if (!firmQuote(flat(parsed.quote), reply)) return { kind: "none", what: null, dueAt: null, question: null }
  const due = typeof parsed.due === "string" ? Date.parse(parsed.due) : NaN
  // A time already past, or months out, was misread: no due time.
  const dueAt = Number.isFinite(due) && due > now - 5 * 60_000 && due < now + DUE_MAX ? due : null
  return { kind, what, dueAt, question: null }
}

// ── The record of calls ───────────────────────────────────────────────────

/** One row per call: the cap counts them, and they show what was caught. */
export class CatchLog {
  constructor(private db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_catches (
        run_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        promise_id TEXT,
        detail TEXT,
        opened INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_request_catches_at ON request_catches(at);
    `)
  }

  /** Calls made since `since`. */
  countSince(since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM request_catches WHERE at >= ?").get(since) as { n: number }).n
  }

  /** Claims the call for this run before it is made: a run is read once,
   *  and a call that hangs still counts against the cap. */
  claim(input: { runId: string; requestId: string; agentId: string; now: number }): boolean {
    this.db.prepare("DELETE FROM request_catches WHERE at < ?").run(input.now - 30 * DAY)
    return this.db.prepare(
      "INSERT OR IGNORE INTO request_catches (run_id, request_id, agent_id, at, kind) VALUES (?, ?, ?, ?, 'pending')",
    ).run(input.runId, input.requestId, input.agentId, input.now).changes > 0
  }

  settle(runId: string, kind: CatchKind | "error" | "skipped", detail: string | null, promiseId: string | null = null, opened = false): void {
    this.db.prepare("UPDATE request_catches SET kind = ?, detail = ?, promise_id = ?, opened = ? WHERE run_id = ?")
      .run(kind, detail?.slice(0, 500) ?? null, promiseId, opened ? 1 : 0, runId)
  }

  /** Requests in this chat that a caught question set waiting on the
   *  owner, and still wait. `opened`: the catch opened it from a turn that
   *  had nothing else to follow. */
  waitingIn(agentId: string, channel: string, chatId: string): Array<{ requestId: string; opened: boolean }> {
    return (this.db.prepare(
      `SELECT c.request_id AS id, MAX(c.opened) AS opened FROM request_catches c JOIN requests r ON r.id = c.request_id
       WHERE c.kind = 'waiting_owner' AND r.state = 'waiting_owner' AND r.agent_id = ? AND r.channel = ? AND r.chat_id = ? GROUP BY c.request_id`,
    ).all(agentId, channel, chatId) as Array<{ id: string; opened: number }>).map((r) => ({ requestId: r.id, opened: r.opened === 1 }))
  }

  /** What was caught since `since`, by kind. */
  summary(since: number): Record<string, number> {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS n FROM request_catches WHERE at >= ? GROUP BY kind").all(since) as Array<{ kind: string; n: number }>
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]))
  }
}

// ── The catcher ───────────────────────────────────────────────────────────

export interface PromiseCatcherDeps {
  store: RequestStore
  log: CatchLog
  /** One model call: the prompt in, the model's text out. */
  generate: (prompt: string, signal: AbortSignal) => Promise<string>
  settings: () => CatchSettings
  say: (msg: string) => void
  now?: () => number
}

export interface TurnEnd {
  /** The request the turn belongs to, as it was when the turn ended. */
  request: RequestRecord
  runId: string
  /** The agent's final reply. */
  reply: string | undefined
}

const isOpen = (r: RequestRecord | null): r is RequestRecord => !!r && (OPEN_STATES as readonly string[]).includes(r.state)

export class PromiseCatcher {
  constructor(private deps: PromiseCatcherDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** A turn of a request ended cleanly. Non-null: the catcher reads the
   *  reply and decides what becomes of the request, a candidate included
   *  (it is kept until the verdict); `settled` resolves with the verdict.
   *  Null: nothing to read, the caller goes on as before. */
  turnEnded(t: TurnEnd): { settled: Promise<CatchKind | null> } | null {
    const settings = this.deps.settings()
    const r = t.request
    const reply = t.reply?.trim()
    if (!settings.enabled || !reply || !mayCatch(reply)) return null
    // A promise the agent made itself, or one the owner owes, is followed already.
    if (r.promise) return null
    if (r.state !== "candidate" && !isOpen(r)) return null
    const now = this.now()
    if (this.deps.log.countSince(now - (now % DAY)) >= settings.dailyCap) return null
    if (!this.deps.log.claim({ runId: t.runId, requestId: r.id, agentId: r.agentId, now })) return null
    return { settled: this.read(t, reply, settings) }
  }

  /** The owner wrote again in a chat where a caught question waits: that
   *  is the answer. A request the catch opened only for the question
   *  closes (the new turn is followed on its own); one that was open
   *  before goes back to work. */
  ownerTurnStarted(agentId: string, channel: string, chatId: string, runId: string): void {
    const now = this.now()
    for (const w of this.deps.log.waitingIn(agentId, channel, chatId)) {
      if (w.opened) this.deps.store.close(w.requestId, "done", `the owner answered in chat (run ${runId})`, now)
      else this.deps.store.progress(w.requestId, now)
    }
  }

  private async read(t: TurnEnd, reply: string, settings: CatchSettings): Promise<CatchKind | null> {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), settings.timeoutSeconds * 1000)
    timer.unref?.()
    let verdict: CatchVerdict | null = null
    try {
      const now = this.now()
      verdict = readVerdict(await this.deps.generate(catchPrompt({ reply, asked: t.request.text, now }), ac.signal), now, reply)
      if (!verdict) this.deps.log.settle(t.runId, "error", "the model gave no verdict that reads")
    } catch (e: any) {
      this.deps.log.settle(t.runId, "error", String(e?.message ?? e))
      this.deps.say(`[requests] ${t.request.id}: reply not read for a promise: ${e?.message ?? e}`)
    } finally {
      clearTimeout(timer)
    }
    try {
      return this.apply(t, verdict, settings)
    } catch (e: any) {
      this.deps.say(`[requests] ${t.request.id}: caught ${verdict?.kind ?? "nothing"} but could not keep it: ${e?.message ?? e}`)
      this.deps.store.discardCandidate(t.request.id)
      return null
    }
  }

  /** What the verdict makes of the request. No verdict: as if none. */
  private apply(t: TurnEnd, v: CatchVerdict | null, settings: CatchSettings): CatchKind | null {
    const { store, log } = this.deps
    const now = this.now()
    // Read again: the owner may have written, or the agent closed it, meanwhile.
    const r = store.get(t.request.id)
    const candidate = r?.state === "candidate"
    const drop = () => { if (candidate) store.discardCandidate(t.request.id) }
    if (!v) {
      drop()
      return null
    }
    if (!r || (!candidate && !isOpen(r))) {
      log.settle(t.runId, "skipped", `${v.kind}, but the request had moved on`)
      return v.kind
    }
    if (v.kind === "none" || (v.kind === "waiting_owner" && !settings.waitingOwner)) {
      log.settle(t.runId, v.kind, v.question)
      drop()
      return v.kind
    }
    if (v.kind === "waiting_owner") {
      // A candidate stays, now open: the owner's answer is what it waits on.
      store.waitOnOwner(r.id, v.question!, now)
      log.settle(t.runId, "waiting_owner", v.question, null, candidate)
      this.deps.say(`[requests] ${r.id}: waits on the owner (caught in the reply): ${v.question}`)
      return "waiting_owner"
    }
    if (!candidate) {
      // The request already follows this work: it gets the due time it lacked.
      if (r.dueAt === null && v.dueAt !== null) store.setLoop(r.id, { dueAt: v.dueAt }, now)
      store.touch(r.id, now)
      log.settle(t.runId, "promise", `${v.what} (on open request ${r.id})`)
      return "promise"
    }
    drop()
    // The agent opened its promise itself in this turn (agentx_request).
    if (store.promisedInChat(r.agentId, r.channel, r.chatId, r.createdAt)) {
      log.settle(t.runId, "promise", `${v.what} (the agent opened its own)`)
      return "promise"
    }
    if (store.openPromises(r.agentId) >= MAX_OPEN_PROMISES) {
      log.settle(t.runId, "skipped", `${r.agentId} holds ${MAX_OPEN_PROMISES} open promises`)
      this.deps.say(`[requests] ${r.id}: promise not opened, ${r.agentId} holds ${MAX_OPEN_PROMISES} open promises`)
      return "promise"
    }
    const p = openPromise(store, {
      agentId: r.agentId,
      owedTo: r.owedTo ?? OWED_TO_OWNER,
      text: v.what!,
      channel: r.channel,
      chatId: r.chatId,
      dueAt: v.dueAt,
      // The run that made it, so its trace is one click away.
      link: { kind: "run", ref: t.runId },
      ...(v.what!.length <= HEADLINE_MAX ? { headline: v.what! } : {}),
      now,
    })
    log.settle(t.runId, "promise", v.what, p.id, true)
    this.deps.say(`[requests] ${p.id}: promise caught in ${r.agentId}'s reply: ${v.what}${v.dueAt ? ` (due ${new Date(v.dueAt).toISOString()})` : ""}`)
    return "promise"
  }
}
