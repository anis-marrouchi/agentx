// Settings for the wiki notes inbox (#825), shared by
// `agentx wiki notes config` and the dashboard's Schedules tab so both
// apply the same checks to agentx.json.

export interface WikiNotesPatch {
  enabled?: boolean
  /** Agent that runs the wiki observe/sweep schedule. "" clears it. */
  inbox?: string
  /** Replace the list of schedules that read the inbox. */
  crons?: string[]
  maxNotesPerRun?: number
  maxDeferrals?: number
}

export interface WikiNotesView {
  enabled: boolean
  inbox: string
  crons: string[]
  maxNotesPerRun: number
  maxDeferrals: number
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/

/** The current settings, with defaults filled in. */
export function wikiNotesSettings(raw: any): WikiNotesView {
  const n = raw && typeof raw === "object" ? raw : {}
  return {
    enabled: n.enabled === true,
    inbox: typeof n.inbox === "string" ? n.inbox : "",
    crons: Array.isArray(n.crons) ? n.crons.filter((c: unknown) => typeof c === "string") : [],
    maxNotesPerRun: Number.isInteger(n.maxNotesPerRun) ? n.maxNotesPerRun : 20,
    maxDeferrals: Number.isInteger(n.maxDeferrals) ? n.maxDeferrals : 3,
  }
}

/**
 * Apply `patch` to `cfg.wikiNotes` in place and say what changed. Throws a
 * message meant for a person when the result would not work.
 *
 * The inbox agent may live on another node (a node that only posts notes),
 * so it is not required to be in `cfg.agents`. A schedule listed in
 * `crons` must exist here and run as the inbox agent: that is the run
 * that reads the notes.
 */
export function patchWikiNotes(cfg: any, patch: WikiNotesPatch): string {
  const cur = { ...(cfg.wikiNotes && typeof cfg.wikiNotes === "object" ? cfg.wikiNotes : {}) }
  const changes: string[] = []

  if (patch.inbox !== undefined) {
    const inbox = String(patch.inbox).trim()
    if (inbox && !ID_RE.test(inbox)) throw new Error(`"${inbox}" is not an agent id`)
    if (inbox) cur.inbox = inbox
    else delete cur.inbox
    changes.push(inbox ? `inbox=${inbox}` : "inbox cleared")
  }
  if (patch.crons !== undefined) {
    const ids = [...new Set(patch.crons.map((c) => String(c).trim()).filter(Boolean))]
    cur.crons = ids
    changes.push(`crons=${ids.length ? ids.join(",") : "none"}`)
  }
  if (patch.maxNotesPerRun !== undefined) {
    const n = Number(patch.maxNotesPerRun)
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("max notes per run must be a whole number from 1 to 100")
    cur.maxNotesPerRun = n
    changes.push(`maxNotesPerRun=${n}`)
  }
  if (patch.maxDeferrals !== undefined) {
    const n = Number(patch.maxDeferrals)
    if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error("deferrals before a note expires must be a whole number from 1 to 20")
    cur.maxDeferrals = n
    changes.push(`maxDeferrals=${n}`)
  }
  if (patch.enabled !== undefined) {
    cur.enabled = Boolean(patch.enabled)
    changes.push(cur.enabled ? "on" : "off")
  }
  if (changes.length === 0) throw new Error("nothing to update")

  if (cur.enabled && !cur.inbox) {
    throw new Error("set the inbox agent first: the agent that runs the wiki observe/sweep schedule")
  }
  for (const id of cur.crons ?? []) {
    const job = cfg.crons?.[id]
    if (!job) throw new Error(`no schedule "${id}" on this node`)
    if (cur.inbox && job.agent !== cur.inbox) {
      throw new Error(`schedule "${id}" runs as "${job.agent}", not the inbox agent "${cur.inbox}"`)
    }
  }

  cfg.wikiNotes = cur
  return `wiki notes updated (${changes.join(", ")})`
}
