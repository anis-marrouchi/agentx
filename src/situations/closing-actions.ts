import { createHash } from "crypto"
import { z } from "zod"
import type { BuiltinAction } from "@/actions/builtin/types"
import { openPromise } from "@/requests/promise"
import { OWED_TO_OWNER, type RequestStore } from "@/requests/store"
import type { SituationStore } from "./store"

// --- The steps of the two situation workflows (#1892, phase 4) ---
//
//   situation.expire    the `situation-expiry` run's step: end the talk as
//                       stale, only if its phase has not changed since the
//                       run started (S9). A missed cancel does nothing.
//   situation.promises  the `situation-close` run's step: each follow-up the
//                       note listed becomes an open promise with an owner
//                       (requests/promise.ts, the one way to open one). A
//                       due time only when a person gave one; else none
//                       ("no time yet"). Run twice for the same end, it
//                       opens nothing new.
//
// Both reach the daemon's stores through `setSituationClosingDeps`, set
// at daemon start, as signal.resume reaches the signal service.

export interface SituationClosingDeps {
  store: Pick<SituationStore, "expire" | "getById">
  requests: () => RequestStore | null
}

let deps: SituationClosingDeps | null = null

/** Attach the stores (daemon start). Null detaches them. */
export function setSituationClosingDeps(d: SituationClosingDeps | null): void {
  deps = d
}

const num = z.union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)])

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
    return deps.store.expire(input.situationId, input.phaseChangedAt)
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
  /** The talk's agent: it holds the promises it owes, and the ones the
   *  owner owes are kept in its name. */
  agent: z.string().min(1).max(100),
  channel: z.string().min(1),
  chatId: z.string().min(1),
  home: z.string().max(500).optional(),
  /** The note step's list, as JSON text (a template renders an array so)
   *  or as an array. Empty or missing: no follow-ups. */
  followUps: z.union([z.string(), z.array(z.unknown())]).optional(),
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

export const situationPromises: BuiltinAction<PromisesInput, PromisesOutput> = {
  name: "situation.promises",
  description: "Open one promise with an owner for each follow-up of a talk that ended (situation-close)",
  inputSchema: promisesInput,
  outputSchema: promisesOutput,
  handler: async (input) => {
    const store = deps?.requests() ?? null
    if (!store) throw new Error("requests are not running in this process")
    const now = Date.now()
    const ids: string[] = []
    const named: string[] = []
    let opened = 0
    for (const f of readFollowUps(input.followUps)) {
      const owner = f.owner || input.agent
      const byOwner = owner.toLowerCase() === OWED_TO_OWNER
      // Who waits: as said, else the owner; the owner never waits on itself.
      let owedTo = f.waitsOn || OWED_TO_OWNER
      if (byOwner && owedTo.toLowerCase() === OWED_TO_OWNER) owedTo = input.agent
      const ref = `situation:${input.situationId}:${input.endGeneration}:${createHash("sha1").update(f.what.toLowerCase()).digest("hex").slice(0, 12)}`
      const had = store.byLink("workflow", ref)
      named.push(`${f.what} (${byOwner ? "you" : owner})`)
      if (had) { ids.push(had.id); continue }
      const due = f.due ? Date.parse(f.due) : NaN
      const r = openPromise(store, {
        agentId: byOwner ? input.agent : owner,
        ...(byOwner ? { owedBy: OWED_TO_OWNER } : {}),
        owedTo,
        text: f.what,
        channel: input.channel,
        chatId: input.chatId,
        dueAt: Number.isFinite(due) && due > now ? due : null,
        link: { kind: "workflow", ref },
        now,
      })
      ids.push(r.id)
      opened++
    }
    const summary = named.length === 0 ? "No follow-ups."
      : `${named.length} follow-up${named.length === 1 ? "" : "s"}, owners named: ${named.join("; ")}.`
    return { opened, ids, summary: summary.slice(0, 600) }
  },
}
