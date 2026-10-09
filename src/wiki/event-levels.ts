// --- Give each event an importance level and the pages it is about (#811) ---
//
// Event pages are half the wiki, and until a level is set they all show
// as `normal` beside decisions and client events. This pass reads the
// event pages (never the raw entries) and writes, per event:
//   - `importance`: minor, normal or major;
//   - `involves` statements: the people, organisations, assets or
//     projects the event is about, so it shows in their History.
// The ontology's `importance.rules` decide first, for free. What they
// leave is sent to a model in batches. Each answer is checked against
// what the call was shown before a page is written through the store,
// which keeps the old version. Where only the owner may set `major`, a
// suggested `major` is stored as a proposal and the event stays `normal`.

import type { WikiHub } from "./hub"
import type { WikiArticleMeta } from "./types"
import { normName, type Entity, type GraphPage, type WikiGraph } from "./ontology/graph"
import { linkedEntities } from "./ontology/lens"
import { IMPORTANCE_LEVELS, type Importance, type ImportanceRule, type Ontology, type WikiStatement } from "./ontology/types"
import { bodyOf } from "./ontology/view-entity"

export const EVENTS_BY = "wiki-events"
/** Statement that records this job set the level; the owner's `set` removes it. */
const LEVEL_MARK = "importance_set"

/** Types an event can be about. Events, due dates and topics are not. */
const ABOUT_SKIP = new Set(["event", "due_date", "topic"])
const MAX_CANDIDATES = 10
const BODY_CHARS = 320

export interface EventItem {
  event: Entity
  /** The page the result is written to: one this node owns. */
  page: GraphPage
  /** Entities the event may be about: linked to it, or named in its title. */
  candidates: Entity[]
}

export interface EventVerdict {
  importance: Importance
  /** Set when `major` was suggested but only the owner may set it. */
  proposed?: Importance
  /** Titles of the candidates the event is about. */
  about: string[]
  why?: string
  by: "rule" | "model"
}

export interface EventOutcome {
  event: string
  title: string
  date: string
  page?: string
  status: "written" | "dry-run" | "no-page" | "no-answer" | "failed"
  importance?: Importance
  proposed?: Importance
  about: string[]
  by?: "rule" | "model"
  why?: string
  dropped: string[]
}

export interface EventsRun {
  outcomes: EventOutcome[]
  costUsd: number
  calls: number
  /** Set when the run stopped at its spending cap. */
  capped: boolean
  /** Events without a level that this run did not reach. */
  left: number
}

export interface EventsCall {
  (prompt: string): Promise<{ text: string; costUsd: number }>
}

export interface EventsOptions {
  /** Entity ids or titles: only events linked to or naming them. */
  about: string[]
  /** Most events per run. */
  max: number
  /** Events per model call. */
  batch: number
  maxCostUsd: number
  dryRun: boolean
  /** Redo events that already have a level set by this job. */
  force: boolean
  /** Skip the model: only the ontology's rules decide. */
  rulesOnly: boolean
  today: string
}

/** The first rule that matches the event, if any. */
export function ruleLevel(rules: ImportanceRule[] | undefined, title: string, tags: string[]): Importance | undefined {
  const have = new Set(tags.map(t => t.toLowerCase()))
  for (const r of rules ?? []) {
    if (!IMPORTANCE_LEVELS.includes(r.level) || (!r.title && !r.tags?.length)) continue
    if (r.title) {
      let re: RegExp
      try { re = new RegExp(r.title, "i") } catch { continue } // reported by checkOntology
      if (!re.test(title)) continue
    }
    if (r.unless) {
      let re: RegExp
      try { re = new RegExp(r.unless, "i") } catch { continue } // reported by checkOntology
      if (re.test(title)) continue
    }
    if (r.tags?.length && !r.tags.some(t => have.has(t.toLowerCase()))) continue
    return r.level
  }
  return undefined
}

/** Entities whose name appears as whole words in `text`. */
function namedEntities(g: WikiGraph, text: string): Entity[] {
  const hay = ` ${normName(text)} `
  const out: Entity[] = []
  for (const e of g.entities.values()) {
    if (ABOUT_SKIP.has(e.type)) continue
    const name = normName(e.title)
    if (name.length >= 4 && hay.includes(` ${name} `)) out.push(e)
  }
  return out
}

/** What the event may be about: pages it links to or that link to it,
 *  then pages its title names. Linked ones first. */
export function eventCandidates(g: WikiGraph, ev: Entity): Entity[] {
  const linked = linkedEntities(g, ev, null).filter(x => !ABOUT_SKIP.has(x.type))
  const named = namedEntities(g, ev.title)
  return [...new Map([...named, ...linked].map(x => [x.id, x])).values()].slice(0, MAX_CANDIDATES)
}

function localPage(hub: Pick<WikiHub, "syncedFrom">, e: Entity): GraphPage | undefined {
  return e.pages.find(p => !hub.syncedFrom(p.agentId))
}

/** True when this job set the page's level. */
function ownLevel(meta: WikiArticleMeta): boolean {
  return (meta.statements ?? []).some(s => s.by === EVENTS_BY && s.property === LEVEL_MARK)
}

/** True when the level on the event was set by a person or another job. */
function setByOthers(ev: Entity): boolean {
  return ev.pages.some(p => p.article.meta.importance && !ownLevel(p.article.meta))
}

/** Events this run should look at, newest first. */
export function pickEvents(hub: Pick<WikiHub, "syncedFrom">, g: WikiGraph, opts: Pick<EventsOptions, "about" | "force">): { items: EventItem[]; noPage: Entity[] } {
  const scope = new Set<string>()
  for (const name of opts.about) {
    const id = g.names.get(normName(name)) ?? (g.entities.has(name) ? name : undefined)
    if (id) scope.add(id)
  }
  const items: EventItem[] = []
  const noPage: Entity[] = []
  const events = [...g.entities.values()].filter(e => e.type === "event").sort((a, b) => (b.date || "").localeCompare(a.date || ""))
  for (const ev of events) {
    const hasLevel = ev.pages.some(p => p.article.meta.importance)
    // A level a person set is never redone; --force redoes only this job's.
    if (hasLevel && (!opts.force || setByOthers(ev))) continue
    const candidates = eventCandidates(g, ev)
    if (opts.about.length && !candidates.some(c => scope.has(c.id))) continue
    const page = localPage(hub, ev)
    if (!page) { noPage.push(ev); continue }
    items.push({ event: ev, page, candidates })
  }
  return { items, noPage }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

export function buildEventsPrompt(items: EventItem[], o: Ontology): string {
  const lines: string[] = [
    "You are sorting the event pages of a company wiki by importance, and saying what each event is about.",
    "",
    "Levels:",
    "- minor: routine upkeep or a small incident with no lasting effect (a disk filled and was cleaned, a job was restarted, a reminder was sent).",
    "- normal: something a person would want in the history of the thing it is about (a delivery, a payment, an outage that was noticed, a meeting with an outcome).",
    "- major: a turning point (a client won or lost, a contract signed, a legal or financial deadline missed, data lost, a decision that changes how things are done).",
    "When unsure between two levels, pick the lower one.",
    "",
    "## Events",
  ]
  items.forEach((it, i) => {
    const body = clip(bodyOf(it.page.article.content).replace(/\s+/g, " ").trim(), BODY_CHARS)
    lines.push(`### ${i + 1}. ${it.event.title} (${it.event.date || "no date"})`, body || "(no text)")
    lines.push(it.candidates.length ? `May be about: ${it.candidates.map(c => `"${c.title}" (${c.type})`).join(", ")}` : "May be about: nothing listed", "")
  })
  lines.push(
    "## Task",
    "Return one JSON object and nothing else:",
    `{"events": [{"n": 1, "importance": "minor", "about": ["Exact Title"], "why": "one short reason"}]}`,
    "",
    "Rules:",
    `- One item per event, with its number. importance is one of ${IMPORTANCE_LEVELS.join(", ")}.`,
    "- about: only titles from that event's own \"May be about\" list, copied exactly, and only the ones the event really concerns: the machine that failed, the client it was for, the person it happened to. Often one, at most three. Leave it empty when none fits.",
    "- why: under 15 words, in English.",
    ...(o.importance.major_set_by === "owner" ? ["- major is only a suggestion here: the owner confirms it."] : []),
  )
  return lines.join("\n")
}

/** The JSON object in the reply, fenced or not. */
function parseReply(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  const raw = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  try {
    const v = JSON.parse(raw)
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Keep `major` for the owner where the ontology says so. */
function withOwnerRule(level: Importance, o: Ontology): Pick<EventVerdict, "importance" | "proposed"> {
  if (level === "major" && o.importance.major_set_by === "owner") return { importance: "normal", proposed: "major" }
  return { importance: level }
}

/** Per-event verdicts from one reply, keeping only what the call was shown. */
export function checkEventsReply(text: string, items: EventItem[], o: Ontology): Map<number, { verdict: EventVerdict; dropped: string[] }> {
  const out = new Map<number, { verdict: EventVerdict; dropped: string[] }>()
  const parsed = parseReply(text)
  for (const raw of Array.isArray(parsed?.events) ? parsed!.events as unknown[] : []) {
    const r = (raw ?? {}) as Record<string, unknown>
    const at = Number(r.n) - 1
    const it = items[at]
    if (!Number.isInteger(at) || !it || out.has(at)) continue
    const level = String(r.importance ?? "").trim().toLowerCase() as Importance
    if (!IMPORTANCE_LEVELS.includes(level)) continue
    const dropped: string[] = []
    const allowed = new Map(it.candidates.map(c => [normName(c.title), c.title]))
    const about: string[] = []
    for (const t of Array.isArray(r.about) ? r.about : []) {
      const title = allowed.get(normName(String(t ?? "")))
      if (title && !about.includes(title)) about.push(title)
      else if (!title && String(t ?? "").trim()) dropped.push(`about ${String(t).trim().slice(0, 80)}: not in the list shown`)
    }
    if (about.length > 3) dropped.push(`about: kept the first 3 of ${about.length}`)
    const why = typeof r.why === "string" ? clip(r.why.trim(), 160) : undefined
    out.set(at, { verdict: { ...withOwnerRule(level, o), about: about.slice(0, 3), why: why || undefined, by: "model" }, dropped })
  }
  return out
}

/** Page meta with the level and this job's `involves` facts replaced. */
export function eventMeta(meta: WikiArticleMeta, v: EventVerdict, today: string): WikiArticleMeta {
  const kept = (meta.statements ?? []).filter(s => s.by !== EVENTS_BY)
  const taken = new Set(kept.filter(s => s.property === "involves").map(s => normName(s.value)))
  const added: WikiStatement[] = v.about
    .filter(t => !taken.has(normName(t)))
    .map(t => ({ property: "involves", value: t, checked_at: today, by: EVENTS_BY }))
  // The marker records that this job set the level, so --force may redo it.
  added.push({ property: LEVEL_MARK, value: v.proposed ?? v.importance, checked_at: today, by: EVENTS_BY, ...(v.why ? { note: v.why } : {}) })
  // `lastUpdated` stays: the level and links are not news about the event,
  // and the catalog sorts and labels pages by that date.
  return { ...meta, importance: v.importance, importanceProposed: v.proposed, statements: [...kept, ...added] }
}

export async function runEvents(hub: WikiHub, g: WikiGraph, call: EventsCall, opts: EventsOptions): Promise<EventsRun> {
  const o = g.ontology
  const { items: all, noPage } = pickEvents(hub, g, opts)
  const items = all.slice(0, opts.max)
  const run: EventsRun = { outcomes: [], costUsd: 0, calls: 0, capped: false, left: all.length - items.length }
  for (const ev of opts.about.length ? noPage : []) {
    run.outcomes.push({ event: ev.id, title: ev.title, date: ev.date, status: "no-page", about: [], dropped: ["its pages are copied from another node"] })
  }

  const write = (it: EventItem, v: EventVerdict, dropped: string[]): void => {
    const where = `${it.page.agentId}/${it.page.article.path}`
    const base: EventOutcome = { event: it.event.id, title: it.event.title, date: it.event.date, page: where, status: "dry-run", importance: v.importance, proposed: v.proposed, about: v.about, by: v.by, why: v.why, dropped }
    if (opts.dryRun) { run.outcomes.push(base); return }
    const store = hub.getAgentWiki(it.page.agentId)
    // Absorb or a person may have changed the page while the run waited
    // for the model: write onto what is on disk now, not the copy read
    // at the start.
    const current = store.readArticle(it.page.article.path)
    if (!current) { run.outcomes.push({ ...base, status: "failed", dropped: [...dropped, "the page was moved or removed during the run"] }); return }
    if (current.meta.importance && !ownLevel(current.meta)) {
      run.outcomes.push({ ...base, status: "failed", dropped: [...dropped, "a level was set on the page during the run"] })
      return
    }
    const ok = store.writeArticle(it.page.article.path, eventMeta(current.meta, v, opts.today), current.content, current.meta.owner || it.page.agentId)
    run.outcomes.push({ ...base, status: ok ? "written" : "failed", dropped: ok ? dropped : [...dropped, "write refused"] })
  }

  // Rules first: free, and the same answer every run.
  const forModel: EventItem[] = []
  for (const it of items) {
    const level = ruleLevel(o.importance.rules, it.event.title, it.page.article.meta.tags ?? [])
    if (!level) { forModel.push(it); continue }
    // A rule gives the level only; what the title names is what it is about.
    const named = new Set(namedEntities(g, it.event.title).map(e => e.id))
    const about = it.candidates.filter(c => named.has(c.id)).slice(0, 3).map(c => c.title)
    write(it, { ...withOwnerRule(level, o), about, why: "matched an importance rule", by: "rule" }, [])
  }
  if (opts.rulesOnly) {
    run.left += forModel.length
    return run
  }

  for (let i = 0; i < forModel.length; i += opts.batch) {
    const batch = forModel.slice(i, i + opts.batch)
    if (run.costUsd >= opts.maxCostUsd) {
      run.capped = true
      run.left += forModel.length - i
      break
    }
    run.calls++
    let verdicts: ReturnType<typeof checkEventsReply>
    try {
      const reply = await call(buildEventsPrompt(batch, o))
      run.costUsd += reply.costUsd
      verdicts = checkEventsReply(reply.text, batch, o)
    } catch (err) {
      for (const it of batch) {
        run.outcomes.push({ event: it.event.id, title: it.event.title, date: it.event.date, page: `${it.page.agentId}/${it.page.article.path}`, status: "failed", about: [], dropped: [(err as Error).message.slice(0, 200)] })
      }
      continue
    }
    batch.forEach((it, at) => {
      const v = verdicts.get(at)
      if (v) write(it, v.verdict, v.dropped)
      else run.outcomes.push({ event: it.event.id, title: it.event.title, date: it.event.date, page: `${it.page.agentId}/${it.page.article.path}`, status: "no-answer", about: [], dropped: ["the reply had no usable item for this event"] })
    })
  }
  if (!opts.dryRun) {
    for (const agentId of new Set(run.outcomes.filter(x => x.status === "written").map(x => x.page!.split("/")[0]))) {
      hub.getAgentWiki(agentId).rebuildIndex()
    }
  }
  return run
}

/** The owner's own word: set a level on an event and clear any proposal. */
export function setEventLevel(hub: WikiHub, g: WikiGraph, name: string, level: Importance): { ok: boolean; title?: string; page?: string; reason?: string } {
  const id = g.names.get(normName(name)) ?? (g.entities.has(name) ? name : undefined)
  const ev = id ? g.entities.get(id) : undefined
  if (!ev) return { ok: false, reason: `no page is titled "${name}"` }
  if (ev.type !== "event") return { ok: false, title: ev.title, reason: `"${ev.title}" is a ${ev.type}, not an event` }
  const page = localPage(hub, ev)
  if (!page) return { ok: false, title: ev.title, reason: "its pages are copied from another node; set the level there" }
  // Dropping this job's marker makes the level the owner's: no run redoes it.
  const store = hub.getAgentWiki(page.agentId)
  const current = store.readArticle(page.article.path) ?? page.article
  const statements = (current.meta.statements ?? []).filter(s => !(s.by === EVENTS_BY && s.property === LEVEL_MARK))
  const meta: WikiArticleMeta = { ...current.meta, importance: level, importanceProposed: undefined, statements: statements.length ? statements : undefined }
  const ok = store.writeArticle(page.article.path, meta, current.content, current.meta.owner || page.agentId)
  if (ok) store.rebuildIndex()
  return { ok, title: ev.title, page: `${page.agentId}/${page.article.path}`, reason: ok ? undefined : "write refused" }
}

export interface AboutSummary {
  title: string
  type: string
  /** Events in its History before this run, and how they split after. */
  before: number
  after: Record<Importance, number>
}

/** For a pilot: what each named page's History looks like after the run. */
export function summariseAbout(g: WikiGraph, run: EventsRun, about: string[]): AboutSummary[] {
  const out: AboutSummary[] = []
  const byEvent = new Map(run.outcomes.filter(x => x.importance).map(x => [x.event, x]))
  for (const name of about) {
    const id = g.names.get(normName(name)) ?? (g.entities.has(name) ? name : undefined)
    const e = id ? g.entities.get(id) : undefined
    if (!e) continue
    const linkedBefore = new Set(linkedEntities(g, e, new Set(["event"])).map(x => x.id))
    const after: Record<Importance, number> = { minor: 0, normal: 0, major: 0 }
    const seen = new Set<string>()
    for (const ev of g.entities.values()) {
      if (ev.type !== "event") continue
      const o = byEvent.get(ev.id)
      const linkedAfter = linkedBefore.has(ev.id) || !!o?.about.some(t => normName(t) === normName(e.title))
      if (!linkedAfter || seen.has(ev.id)) continue
      seen.add(ev.id)
      after[o?.importance ?? ev.importance]++
    }
    out.push({ title: e.title, type: e.type, before: linkedBefore.size, after })
  }
  return out
}
