import { z } from "zod"
import type { BuiltinAction } from "@/actions/builtin/types"
import { openPromise } from "@/requests/promise"
import { OWED_TO_OWNER, type RequestStore } from "@/requests/store"
import { forgeChatOf, forgeHomeOf } from "@/daemon/wall-forge-state"
import type { SituationsConfig } from "./config"
import type { SituationStore } from "./store"
import { oneLine, quoted } from "./templates"

// --- The steps of the two situation workflows (#1892, phase 4) ---
//
//   situation.expire      the `situation-expiry` run's step: end the talk
//                         as stale, only if closing steps are on and its
//                         phase has not changed since the run started (S9).
//                         A missed cancel does nothing.
//   situation.transcript  the `situation-close` run's first step: a bounded
//                         excerpt of the talk (its group log), read only,
//                         for the note's agent.
//   situation.note        posts the note the agent drafted as one comment
//                         on the home (a GitHub or GitLab issue, pull or
//                         merge request). The agent's turn is read only
//                         (`autonomy: report`): it cannot send to any
//                         channel; this step can only post at the home.
//   situation.promises    each follow-up the note listed becomes an open
//                         promise with an owner (requests/promise.ts, the
//                         one way to open one). A due time only when a
//                         person gave one; else none ("no time yet"). One
//                         set per close generation: run again, even with
//                         other words, it opens nothing new.
//
// They reach the daemon through `setSituationClosingDeps`, set at daemon
// start, as signal.resume reaches the signal service.

export interface NoteTarget { channel: "github" | "gitlab"; chatId: string }

export interface SituationClosingDeps {
  store: Pick<SituationStore, "expire" | "getById" | "noteFor" | "setNote">
  requests: () => RequestStore | null
  /** Closing steps on? (`situations.mode` not off, `closing.enabled`). */
  settings?: () => SituationsConfig
  /** Is this a known agent of this node? */
  isAgent?: (id: string) => boolean
  /** The talk's recent messages, oldest first. */
  transcript?: (channel: string, chatId: string) => Array<{ sender: string; text: string; timestamp: number }>
  /** This node's GitLab address, for GitLab homes. */
  gitlabUrl?: () => string | null
  /** Post one comment at the home. Returns its link, or null. */
  /** `key`: the post's idempotency key, one per talk and end. */
  postNote?: (target: NoteTarget, text: string, agentId: string | undefined, home: string, key: string) => Promise<string | null>
}

let deps: SituationClosingDeps | null = null

/** Attach the stores (daemon start). Null detaches them. */
export function setSituationClosingDeps(d: SituationClosingDeps | null): void {
  deps = d
}

/** The forge item a home link names, as its channel's chat id. Null: the
 *  home is not a GitHub or GitLab (this node's) issue, pull or merge
 *  request. */
export function noteTargetOf(home: string, gitlabUrl: string | null | undefined): NoteTarget | null {
  const h = forgeHomeOf({ home: { link: home }, group: { channel: "", chatId: "" } } as never, gitlabUrl)
  return h ? { channel: h.provider, chatId: forgeChatOf(h) } : null
}

const num = z.union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)])

function closingOn(): boolean {
  try {
    const s = deps?.settings?.()
    return !s || (s.mode !== "off" && s.closing?.enabled === true)
  } catch { return false }
}

const expireInput = z.object({ situationId: z.string().min(1), phaseChangedAt: num })
type ExpireInput = z.infer<typeof expireInput>
const expireOutput = z.object({ ended: z.boolean(), why: z.string() })
type ExpireOutput = z.infer<typeof expireOutput>

export const situationExpire: BuiltinAction<ExpireInput, ExpireOutput> = {
  name: "situation.expire",
  description: "End a talk as stale at its phase's max age, only if the phase has not changed since (situation-expiry)",
  inputSchema: expireInput,
  outputSchema: expireOutput,
  handler: async (input) => {
    if (!deps) return { ended: false, why: "situations are not running in this process" }
    if (!closingOn()) return { ended: false, why: "closing steps are off (situations.closing.enabled or situations.mode)" }
    return deps.store.expire(input.situationId, input.phaseChangedAt)
  },
}

/** The excerpt's size: the newest messages that fit. */
export const TRANSCRIPT_MAX_CHARS = 6000
const TRANSCRIPT_MAX_LINE = 600

const transcriptInput = z.object({ channel: z.string().min(1), chatId: z.string().min(1) })
type TranscriptInput = z.infer<typeof transcriptInput>
const transcriptOutput = z.object({ text: z.string(), messages: z.number() })
type TranscriptOutput = z.infer<typeof transcriptOutput>

export const situationTranscript: BuiltinAction<TranscriptInput, TranscriptOutput> = {
  name: "situation.transcript",
  description: "A bounded excerpt of a talk's recent messages, for its closing note (situation-close)",
  inputSchema: transcriptInput,
  outputSchema: transcriptOutput,
  handler: async (input) => {
    let entries: Array<{ sender: string; text: string }> = []
    try { entries = deps?.transcript?.(input.channel, input.chatId) ?? [] } catch { entries = [] }
    const lines: string[] = []
    let size = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      const text = String(e.text ?? "").replace(/\s+/g, " ").trim()
      const line = `${String(e.sender ?? "?").slice(0, 60)}: ${text.length > TRANSCRIPT_MAX_LINE ? `${text.slice(0, TRANSCRIPT_MAX_LINE)}…` : text}`
      if (size + line.length + 1 > TRANSCRIPT_MAX_CHARS) break
      lines.unshift(line)
      size += line.length + 1
    }
    return { text: lines.length ? lines.join("\n") : "(no messages of this talk are kept on this node)", messages: lines.length }
  },
}

const noteInput = z.object({
  situationId: z.string().min(1),
  endGeneration: num,
  /** Empty: no home (phase 6, steps the agent named). The note is not
   *  posted; it goes to the owner's message only. */
  home: z.string().max(500),
  /** The talk's agent: the comment is posted as it. */
  agent: z.string().max(100).optional(),
  purpose: z.string().max(300).optional(),
  note: z.string().max(20_000).optional(),
})
type NoteInput = z.infer<typeof noteInput>
/** `noteAt`: the posted note's link, or NO_NOTE when the agent drafted none. */
const noteOutput = z.object({ noteAt: z.string() })
type NoteOutput = z.infer<typeof noteOutput>

/** An empty draft posts nothing and does not stop the run: the follow-ups
 *  still become promises (#1973). Words, not a link, because the installed
 *  template reads "Note: {{post_note.noteAt}}." and is never rewritten. */
export const NO_NOTE = "none, the agent drafted no note"
/** A note with no home, in the owner's message, is cut to this size. */
export const OWNER_NOTE_MAX = 1200

export const situationNote: BuiltinAction<NoteInput, NoteOutput> = {
  name: "situation.note",
  description: "Post a talk's closing note as one comment at its home issue or merge request (situation-close)",
  inputSchema: noteInput,
  outputSchema: noteOutput,
  handler: async (input) => {
    // No home (an agent named the steps; it may not pick where a note of a
    // private talk is posted): the note goes to the owner only, one line
    // and quoted, since the agent wrote it. Nothing is posted.
    if (!input.home.trim()) {
      return { noteAt: oneLine(input.note, OWNER_NOTE_MAX) ? `for you only: ${quoted(input.note, OWNER_NOTE_MAX)}` : NO_NOTE }
    }
    if (!deps?.postNote) throw new Error("posting notes is not running in this process")
    const target = noteTargetOf(input.home, deps.gitlabUrl?.() ?? null)
    if (!target) throw new Error(`the home ${input.home} is not a GitHub or GitLab issue, pull or merge request of this node`)
    // One note per end: a re-run or a retry of this step posts nothing new.
    const had = deps.store.noteFor(input.situationId, input.endGeneration)
    if (had) return { noteAt: had }
    const body = (input.note ?? "").trim()
    if (!body) return { noteAt: NO_NOTE }
    const key = `situation:${input.situationId}:${input.endGeneration}:note`
    const link = (await deps.postNote(target, body, input.agent || undefined, input.home, key)) ?? input.home
    deps.store.setNote(input.situationId, input.endGeneration, link)
    return { noteAt: link }
  },
}

const followUp = z.object({
  what: z.string().trim().min(1).max(500),
  owner: z.string().trim().max(100).optional(),
  waitsOn: z.string().trim().max(100).optional(),
  due: z.string().trim().max(60).optional(),
})
type FollowUp = z.infer<typeof followUp>

const promisesInput = z.object({
  situationId: z.string().min(1),
  endGeneration: num,
  /** The talk's agent: it holds the promises it owes, the ones the owner
   *  owes are kept in its name, and so are the ones named to anyone the
   *  closing steps do not allow. */
  agent: z.string().min(1).max(100),
  channel: z.string().min(1),
  chatId: z.string().min(1),
  home: z.string().max(500).optional(),
  /** The note step's list, as JSON text (a template renders an array so)
   *  or as an array. Empty or missing: no follow-ups. */
  followUps: z.union([z.string(), z.array(z.unknown())]).optional(),
  /** How many messages of the talk the agent read. 0: it read none, so
   *  any follow-up it lists is a guess and no promise is opened. */
  transcriptMessages: num.optional(),
})
type PromisesInput = z.infer<typeof promisesInput>
const promisesOutput = z.object({ opened: z.number(), ids: z.array(z.string()), summary: z.string() })
type PromisesOutput = z.infer<typeof promisesOutput>

const MAX_FOLLOW_UPS = 20

/** The follow-ups an agent listed, the unreadable ones left out. */
export function readFollowUps(v: unknown): FollowUp[] {
  let list: unknown = v
  if (typeof v === "string") {
    if (!v.trim()) return []
    try { list = JSON.parse(v) } catch { return [] }
  }
  if (!Array.isArray(list)) return []
  return list.slice(0, MAX_FOLLOW_UPS).flatMap((x) => {
    const r = followUp.safeParse(x)
    return r.success ? [r.data] : []
  })
}

/** Who may own a follow-up: the talk's agent, the owner, and the agents of
 *  this node the closing steps allow. The note's agent writes the names;
 *  they are never trusted beyond that list. */
/** By lower-case name, the id as this node spells it. */
function allowedOwners(situationId: string, agent: string): Map<string, string> {
  const allowed = new Map([[agent.toLowerCase(), agent], [OWED_TO_OWNER, OWED_TO_OWNER]])
  const extra = deps?.store.getById(situationId)?.closing?.agents ?? []
  for (const a of extra) if (!deps?.isAgent || deps.isAgent(a)) allowed.set(a.toLowerCase(), a)
  return allowed
}

export const situationPromises: BuiltinAction<PromisesInput, PromisesOutput> = {
  name: "situation.promises",
  description: "Open one promise with an owner for each follow-up of a talk that ended (situation-close)",
  inputSchema: promisesInput,
  outputSchema: promisesOutput,
  handler: async (input) => {
    const store = deps?.requests() ?? null
    if (!store) throw new Error("requests are not running in this process")
    const now = Date.now()
    const prefix = `situation:${input.situationId}:${input.endGeneration}`
    // One set per close generation: the first item's link marks the set.
    // Its items are opened in one synchronous pass, so a set is never half
    // written.
    const had = store.byLink("workflow", `${prefix}:0`)
    if (had) {
      const ids: string[] = []
      for (let i = 0; i < MAX_FOLLOW_UPS; i++) {
        const r = i === 0 ? had : store.byLink("workflow", `${prefix}:${i}`)
        if (!r) break
        ids.push(r.id)
      }
      return { opened: 0, ids, summary: `${ids.length} follow-up${ids.length === 1 ? "" : "s"} already opened for this end.` }
    }
    if (input.transcriptMessages === 0) {
      return { opened: 0, ids: [], summary: "No follow-ups: no messages of this talk are kept on this node." }
    }
    const allowed = allowedOwners(input.situationId, input.agent)
    const ids: string[] = []
    const named: string[] = []
    let opened = 0
    readFollowUps(input.followUps).forEach((f, i) => {
      const said = f.owner || input.agent
      const byOwner = said.toLowerCase() === OWED_TO_OWNER
      // M2: a name the closing steps do not allow is not an owner: the
      // talk's agent keeps the promise, and the name stays in its words.
      const known = allowed.get(said.toLowerCase())
      const ok = known !== undefined
      const owner = known ?? input.agent
      const text = ok ? f.what : `${f.what} (named owner: ${said})`.slice(0, 600)
      // Who waits: as said, else the owner; the owner never waits on itself.
      let owedTo = f.waitsOn || OWED_TO_OWNER
      if (byOwner && owedTo.toLowerCase() === OWED_TO_OWNER) owedTo = input.agent
      named.push(`${f.what} (${byOwner ? "you" : said}${ok ? "" : ", kept by " + input.agent})`)
      const due = f.due ? Date.parse(f.due) : NaN
      const r = openPromise(store, {
        agentId: byOwner ? input.agent : owner,
        ...(byOwner ? { owedBy: OWED_TO_OWNER } : {}),
        owedTo,
        text,
        channel: input.channel,
        chatId: input.chatId,
        dueAt: Number.isFinite(due) && due > now ? due : null,
        link: { kind: "workflow", ref: `${prefix}:${i}` },
        now,
      })
      ids.push(r.id)
      opened++
    })
    const summary = named.length === 0 ? "No follow-ups."
      : `${named.length} follow-up${named.length === 1 ? "" : "s"}, owners named: ${named.join("; ")}.`
    return { opened, ids, summary: summary.slice(0, 600) }
  },
}
