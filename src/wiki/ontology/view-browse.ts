// --- Home, pillar pages (Z1), full kind lists, search, ontology page ---

import type { Entity, WikiGraph } from "./graph"
import { linkedEntities } from "./lens"
import { summaryOf } from "./view-entity"
import { IMPORTANCE_LEVELS } from "./types"
import { crumbs, entityHref, esc, icon, layout, sidebar, typeIcon, typeLabel, zoomBar } from "./view-layout"

const DAY = 86_400_000

function byType(g: WikiGraph): Map<string, Entity[]> {
  const out = new Map<string, Entity[]>()
  for (const e of g.entities.values()) {
    const list = out.get(e.type) ?? []
    list.push(e)
    out.set(e.type, list)
  }
  return out
}

/** Latest activity: newest linked event, else the page's own date. */
function activity(g: WikiGraph, e: Entity): string {
  if (e.type === "event") return e.date || e.updated
  const ev = linkedEntities(g, e, new Set(["event"]))[0]
  const own = e.updated || e.date
  return ev && ev.date > own ? ev.date : own
}

interface Attention { e: Entity; chip: string; why: string }

/** Things that need a person: unconfirmed, due soon, late, or a recent major event. */
export function needsAttention(g: WikiGraph, entities: Entity[], now = Date.now()): Attention[] {
  const out: Attention[] = []
  const soon = new Date(now + 14 * DAY).toISOString().slice(0, 10)
  const today = new Date(now).toISOString().slice(0, 10)
  for (const e of entities) {
    const due = e.statements.find(s => s.property === "due" && /^\d{4}-\d{2}-\d{2}/.test(s.value))
    const fulfilled = e.statements.some(s => s.property === "fulfilled_by") || e.statements.some(s => s.property === "status" && /^(fulfilled|done|paid|filed)$/i.test(s.value))
    if (e.statements.some(s => s.property === "status" && /^late$/i.test(s.value))) {
      out.push({ e, chip: "late", why: "marked late" })
    } else if (due && !fulfilled && due.value < today) {
      out.push({ e, chip: "late", why: `was due ${due.value}` })
    } else if (due && !fulfilled && due.value <= soon) {
      out.push({ e, chip: "due", why: `due ${due.value}` })
    } else if (e.statements.some(s => s.status === "proposed")) {
      out.push({ e, chip: "proposed", why: "statements wait for confirmation" })
    } else if (e.type === "event" && e.importanceProposed && e.importanceProposed !== e.importance) {
      out.push({ e, chip: "proposed", why: `proposed as ${e.importanceProposed}; the owner decides` })
    } else if (e.type === "event" && e.importance === "major" && e.date && now - Date.parse(e.date) <= 30 * DAY) {
      out.push({ e, chip: "major", why: `major event ${e.date}` })
    }
  }
  const rank: Record<string, number> = { late: 0, due: 1, major: 2, proposed: 3 }
  return out.sort((a, b) => rank[a.chip] - rank[b.chip])
}

function entityRow(g: WikiGraph, e: Entity, right = "", sub?: string): string {
  return `<div class="ox-row"><span class="ox-ic">${typeIcon(g.ontology, e.type)}</span><div class="t"><a href="${entityHref(e.id)}">${esc(e.title)}</a>`
    + `<div class="ox-sub">${esc(sub ?? `${typeLabel(g.ontology, e.type).toLowerCase()} · ${activity(g, e)}`)}</div></div><div class="r">${right}</div></div>`
}

function attentionCard(g: WikiGraph, list: Attention[]): string {
  const rows = list.slice(0, 6).map(a => entityRow(g, a.e, `<span class="ox-st ${a.chip}">${a.chip}</span>`, a.why)).join("")
  return `<section class="ox-card"><div class="ox-card-h"><h2>Needs attention</h2><span class="note">${list.length}</span></div>${rows || `<div class="ox-empty">Nothing waits on a person.</div>`}</section>`
}

function errorsBox(errors: string[]): string {
  if (!errors.length) return ""
  return `<div class="ox-err"><b>ontology.yaml has ${errors.length} problem${errors.length === 1 ? "" : "s"}</b> — the defaults are used where they apply. <a href="/ontology">See them</a></div>`
}

export function homePage(g: WikiGraph, errors: string[]): string {
  const types = byType(g)
  let main = `<div class="ox-bar">${crumbs([])}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${icon("home")}</div><div><h1>Wiki</h1><p>${g.entities.size} things, merged from every agent's pages and typed by the <a href="/ontology">ontology</a>. <a href="/agents">Agent wikis</a> · <a href="/entries">raw entries</a></p></div></div>`
  main += errorsBox(errors)
  main += `<div class="ox-grid3">`
  for (const p of g.ontology.pillars) {
    const inPillar = g.ontology.types.filter(t => t.pillar === p.id)
    const count = inPillar.reduce((n, t) => n + (types.get(t.id)?.length ?? 0), 0)
    const kinds = inPillar.filter(t => types.get(t.id)?.length).map(t => `${t.plural ?? t.label} ${types.get(t.id)!.length}`).join(" · ")
    main += `<a class="ox-card" href="/p/${encodeURIComponent(p.id)}" style="color:inherit"><div class="ox-card-h"><span class="ox-ic">${icon(p.icon)}</span><h2>${esc(p.label)}</h2><span class="zin">${count}</span></div><div class="ox-sub" style="white-space:normal">${esc(p.description ?? "")}</div><div class="ox-sub" style="margin-top:6px;white-space:normal">${esc(kinds || "nothing yet")}</div></a>`
  }
  main += `</div><div class="ox-grid2">`
  const events = (types.get("event") ?? []).filter(e => e.importance !== "minor").sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8)
  main += `<section class="ox-card"><div class="ox-card-h"><h2>Recent events</h2><span class="note">major and normal</span><a class="zin" href="/p/events">all (Z1) →</a></div>`
    + (events.map(e => `<div class="ox-ev"><span class="d">${esc(e.date)}</span><span class="ox-st ${e.importance}">${e.importance}</span><a href="${entityHref(e.id)}">${esc(e.title)}</a></div>`).join("") || `<div class="ox-empty">No events yet.</div>`) + `</section>`
  main += attentionCard(g, needsAttention(g, [...g.entities.values()]))
  main += `</div>`
  return layout("Wiki", sidebar(g, { home: true }), main)
}

/** Z1: the kinds inside a pillar as tabs, what needs attention, the most active pages. */
export function pillarPage(g: WikiGraph, pillarId: string, kind: string | null): string | null {
  const p = g.ontology.pillars.find(x => x.id === pillarId)
  if (!p) return null
  const types = byType(g)
  const kinds = g.ontology.types.filter(t => t.pillar === p.id)
  const active = kinds.find(t => t.id === kind) ?? kinds.find(t => types.get(t.id)?.length) ?? kinds[0]
  let main = `<div class="ox-bar">${crumbs([{ label: p.label }])}${zoomBar(1)}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${icon(p.icon)}</div><div><h1>${esc(p.label)}</h1><p>${esc(p.description ?? "")}</p></div></div>`
  main += `<nav class="ox-tabs">${kinds.map(t => `<a class="${t.id === active?.id ? "on" : ""}" href="/p/${encodeURIComponent(p.id)}?kind=${encodeURIComponent(t.id)}">${esc(t.plural ?? t.label)}<small>${types.get(t.id)?.length ?? 0}</small></a>`).join("")}</nav>`
  const list = active ? (types.get(active.id) ?? []).map(e => ({ e, at: activity(g, e) })).sort((a, b) => b.at.localeCompare(a.at)) : []
  main += `<div class="ox-grid2">`
  main += `<section class="ox-card"><div class="ox-card-h"><h2>${esc(active?.plural ?? active?.label ?? "")}</h2><span class="note">${list.length} · most active first</span>`
    + (active ? `<a class="zin" href="/p/${encodeURIComponent(p.id)}/${encodeURIComponent(active.id)}">open list (Z3) →</a>` : "") + `</div>`
    + (list.slice(0, 5).map(({ e, at }) => entityRow(g, e, e.type === "event" ? `<span class="ox-st ${e.importance}">${e.importance}</span>` : "", `${summaryOf(e, 90) || typeLabel(g.ontology, e.type).toLowerCase()} · ${at}`)).join("") || `<div class="ox-empty">No ${esc((active?.plural ?? "pages").toLowerCase())} yet.</div>`)
    + `</section>`
  const inPillar = kinds.flatMap(t => types.get(t.id) ?? [])
  main += attentionCard(g, needsAttention(g, inPillar))
  main += `</div>`
  return layout(p.label, sidebar(g, { pillar: p.id }), main)
}

/** Every page of one kind, paginated. */
export function kindListPage(g: WikiGraph, pillarId: string, typeId: string, page: number, requested: string | null): string | null {
  // Only known levels reach the filter and the pager hrefs; anything else lists every page.
  const importance = requested && (IMPORTANCE_LEVELS as readonly string[]).includes(requested) ? requested : null
  const p = g.ontology.pillars.find(x => x.id === pillarId)
  const t = g.ontology.types.find(x => x.id === typeId && x.pillar === pillarId)
  if (!p || !t) return null
  let list = [...g.entities.values()].filter(e => e.type === t.id)
  if (importance) list = list.filter(e => e.importance === importance)
  const rows = list.map(e => ({ e, at: activity(g, e) })).sort((a, b) => b.at.localeCompare(a.at))
  const size = 50
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const base = `/p/${encodeURIComponent(p.id)}/${encodeURIComponent(t.id)}`
  let main = `<div class="ox-bar">${crumbs([{ label: p.label, href: `/p/${encodeURIComponent(p.id)}` }, { label: t.plural ?? t.label }])}${zoomBar(3)}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${icon(t.icon)}</div><div><h1>${esc(t.plural ?? t.label)}</h1><p>${rows.length} page${rows.length === 1 ? "" : "s"}${importance ? ` · ${esc(importance)} only` : ""}</p></div></div>`
  if (t.id === "event") {
    main += `<nav class="ox-tabs">${["", "major", "normal", "minor"].map(lv => `<a class="${(importance ?? "") === lv ? "on" : ""}" href="${base}${lv ? `?importance=${lv}` : ""}">${lv || "all"}</a>`).join("")}</nav>`
  }
  main += `<section class="ox-card" style="margin-top:16px">`
    + (rows.slice((page - 1) * size, page * size).map(({ e, at }) => entityRow(g, e, e.type === "event" ? `<span class="ox-st ${e.importance}">${e.importance}</span>` : "", `${at} · ${e.pages.map(x => x.agentId).filter((a, i, all) => all.indexOf(a) === i).join(", ")}`)).join("") || `<div class="ox-empty">None.</div>`)
    + `</section>`
  if (pages > 1) {
    const q = importance ? `importance=${importance}&` : ""
    main += `<div class="ox-pager">${page > 1 ? `<a href="${base}?${q}page=${page - 1}">← previous</a>` : ""}<span>page ${page} of ${pages}</span>${page < pages ? `<a href="${base}?${q}page=${page + 1}">next →</a>` : ""}</div>`
  }
  return layout(t.plural ?? t.label, sidebar(g, { pillar: p.id }), main)
}

export function findPage(g: WikiGraph, q: string): string {
  const needle = q.trim().toLowerCase()
  const scored: Array<{ e: Entity; s: number }> = []
  if (needle) {
    for (const e of g.entities.values()) {
      const title = e.title.toLowerCase()
      let s = title === needle ? 100 : title.startsWith(needle) ? 60 : title.includes(needle) ? 40 : 0
      if (!s && e.pages.some(p => p.article.content.toLowerCase().includes(needle))) s = 10
      if (s) scored.push({ e, s })
    }
  }
  scored.sort((a, b) => b.s - a.s || (b.e.updated).localeCompare(a.e.updated))
  let main = `<div class="ox-bar">${crumbs([{ label: "Search" }])}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${icon("search")}</div><div><h1>${needle ? `“${esc(q)}”` : "Search"}</h1><p>${scored.length} match${scored.length === 1 ? "" : "es"}</p></div></div>`
  main += `<section class="ox-card">${scored.slice(0, 60).map(({ e }) => entityRow(g, e)).join("") || `<div class="ox-empty">No page matches.</div>`}</section>`
  return layout(`Search: ${q}`, sidebar(g, {}), main, "", q)
}

/** What the ontology holds, and any problems in ontology.yaml. */
export function ontologyPage(g: WikiGraph, errors: string[], file: string | null): string {
  const o = g.ontology
  const types = byType(g)
  let main = `<div class="ox-bar">${crumbs([{ label: "Ontology" }])}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${icon("steps")}</div><div><h1>Ontology</h1><p>${file ? `Read from ${esc(file)}` : "Built-in defaults. Run <code>agentx wiki ontology init</code> to write an ontology.yaml you can edit."}</p></div></div>`
  if (errors.length) main += `<div class="ox-err"><b>Problems</b><ul>${errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>`
  main += `<section class="ox-card"><div class="ox-card-h"><h2>Types</h2><span class="note">${o.types.length}</span></div>`
  for (const t of o.types) {
    const pillar = o.pillars.find(p => p.id === t.pillar)
    main += `<div class="ox-row"><span class="ox-ic">${icon(t.icon)}</span><div class="t"><span class="l">${esc(t.label)} <span class="ox-sub">${esc(t.id)}</span></span><div class="ox-sub">${esc(pillar?.label ?? t.pillar)} · lens: ${esc((t.lens ?? []).map(l => l.title ?? l.panel).join(" → "))}</div></div><div class="r"><span class="ox-chip">${types.get(t.id)?.length ?? 0}</span></div></div>`
  }
  main += `</section><section class="ox-card" style="margin-top:16px"><div class="ox-card-h"><h2>Relations</h2><span class="note">${o.properties.length}</span></div>`
  for (const p of o.properties) {
    main += `<div class="ox-kv"><span class="k">${esc(p.id)}</span><span>${esc(p.label)}${p.inverse ? ` · inverse: ${esc(p.inverse)}` : ""}${p.wikidata ? ` <span class="ox-sub">${esc(p.wikidata)}</span>` : ""}</span></div>`
  }
  main += `</section><section class="ox-card" style="margin-top:16px"><div class="ox-card-h"><h2>Event importance</h2></div><div class="ox-kv"><span class="k">default</span><span>${esc(o.importance.default)}</span></div><div class="ox-kv"><span class="k">major set by</span><span>${esc(o.importance.major_set_by)}</span></div><div class="ox-kv"><span class="k">roll-up</span><span>${o.importance.rollup.min} minor events in ${o.importance.rollup.days} days</span></div></section>`
  return layout("Ontology", sidebar(g, {}), main)
}
