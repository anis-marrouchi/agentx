// --- Entity pages: overview (Z2), one panel (Z3), one statement (Z4) ---

import { markdownToHtml } from "@/utils/markdown-html"
import type { WikiEntry } from "../types"
import { normName, type Entity, type WikiGraph } from "./graph"
import { lensFor, panelData } from "./lens"
import { panelSource } from "./load"
import type { LensPanel } from "./types"
import { panelCard } from "./view-panels"
import { crumbs, entityHref, esc, icon, layout, sidebar, typeIcon, typeLabel, zoomBar } from "./view-layout"

export interface EntityViewCtx {
  g: WikiGraph
  readEntries: (ids: string[]) => WikiEntry[]
  /** Saved earlier versions of one agent's page, newest first. */
  versions: (agentId: string, path: string) => Array<{ timestamp: string }>
}

/** Article markdown with [[links]] pointing at entity pages. */
export function wikiMd(g: WikiGraph, text: string): string {
  return markdownToHtml(text.replace(/<!--\s*tags?:[^>]*-->\s*\n?/gi, "").replace(/<!-- \/overview -->\s*\n?/g, ""), {
    wikilink: (target, display) => {
      const id = g.names.get(normName(target))
      return id
        ? `<a href="${entityHref(id)}" class="wikilink">${display}</a>`
        : `<a href="/find?q=${encodeURIComponent(target)}" class="wikilink broken" title="No page yet">${display}</a>`
    },
  })
}

/** Page body without a second frontmatter block some older pages carry. */
export function bodyOf(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()
}

const OVERVIEW_HEADING = /^##[ \t]+Overview[ \t]*$/im
/** Closes an Overview section on pages whose other text has no headings. */
export const OVERVIEW_END = "<!-- /overview -->"

/** Where the Overview section starts and ends in a body, if it has one. */
export function overviewSpan(body: string): { start: number; textStart: number; end: number; after: number } | undefined {
  const m = OVERVIEW_HEADING.exec(body)
  if (!m) return undefined
  const textStart = m.index + m[0].length
  const rest = body.slice(textStart)
  const marker = rest.indexOf(OVERVIEW_END)
  const heading = rest.search(/^#{1,2}[ \t]/m)
  const cut = [marker, heading].filter(i => i >= 0)
  const end = textStart + (cut.length ? Math.min(...cut) : rest.length)
  const after = marker >= 0 && textStart + marker === end ? end + OVERVIEW_END.length : end
  return { start: m.index, textStart, end, after }
}

/** The `## Overview` section of a page body, without its heading. */
export function overviewSection(content: string): string | undefined {
  const body = bodyOf(content)
  const span = overviewSpan(body)
  const text = span ? body.slice(span.textStart, span.end).trim() : ""
  return text || undefined
}

/** The newest `## Overview` any of the entity's pages has (#820). */
export function overviewOf(e: Entity): string | undefined {
  const pages = [...e.pages].sort((a, b) => (b.article.meta.lastUpdated || "").localeCompare(a.article.meta.lastUpdated || ""))
  for (const p of pages) {
    const text = overviewSection(p.article.content)
    if (text) return text
  }
  return undefined
}

/** Cut at the last sentence end that fits, else at a word. */
export function cutAtSentence(text: string, max: number): string {
  if (text.length <= max) return text
  const head = text.slice(0, max)
  const end = Math.max(...[". ", "! ", "? ", "؟ ", "。"].map(s => head.lastIndexOf(s)))
  if (end > max / 3) return head.slice(0, end + 1)
  return `${head.replace(/\s+\S*$/, "")}…`
}

/** First paragraph of the first page, as plain text. */
export function summaryOf(e: Entity, max = 360): string {
  const body = bodyOf(e.pages[0]?.article.content ?? "")
  const para = body.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("```")) ?? ""
  const plain = para
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t, d) => d ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return cutAtSentence(plain, max)
}

function pillarOf(g: WikiGraph, e: Entity) {
  return g.ontology.pillars.find(p => p.id === e.pillar)
}

function entityCrumbs(g: WikiGraph, e: Entity, tail: Array<{ label: string; href?: string }> = []): string {
  const p = pillarOf(g, e)
  return crumbs([
    { label: p?.label ?? e.pillar, href: `/p/${encodeURIComponent(e.pillar)}` },
    { label: typeLabel(g.ontology, e.type), href: `/p/${encodeURIComponent(e.pillar)}?kind=${encodeURIComponent(e.type)}` },
    { label: e.title, href: tail.length ? entityHref(e.id) : undefined },
    ...tail,
  ])
}

function notesHtml(g: WikiGraph, e: Entity, full: boolean): string {
  if (!full) {
    const first = e.pages[0]
    if (!first) return ""
    // The overview card above already shows the Overview section.
    const body = bodyOf(first.article.content)
    const span = overviewSpan(body)
    const text = (span ? body.slice(0, span.start) + body.slice(span.after) : body).trim()
    const short = text.length > 1600 ? `${text.slice(0, 1600).replace(/\n[^\n]*$/, "")}\n\n…` : text
    return `<div class="ox-prose">${wikiMd(g, short)}</div>`
  }
  return e.pages.map(p => `<div class="ox-sub">from ${esc(p.agentId)} · ${esc(p.article.path)} · updated ${esc(p.article.meta.lastUpdated || "—")}</div>`
    + `<div class="ox-prose">${wikiMd(g, bodyOf(p.article.content))}</div>`).join(`<hr style="border:0;border-top:1px solid var(--edge);margin:16px 0">`)
}

function rail(g: WikiGraph, e: Entity, lens: LensPanel[]): string {
  const t = g.ontology.types.find(x => x.id === e.type)
  let html = `<span class="ox-lbl">Lens for this type</span><div class="ox-annot"><b>${esc(t?.label ?? e.type)}</b> opens with:<ol>`
  html += lens.map(p => `<li>${esc(p.title ?? p.panel)}</li>`).join("")
  html += `</ol><span class="ox-sub">from ontology.yaml · types.${esc(e.type)}.lens</span></div>`
  html += `<span class="ox-lbl" style="margin-top:20px">Zoom in</span>`
  for (const p of lens) {
    html += `<div class="ox-row"><span class="ox-ic">${icon(panelSource(p) === "history" ? "calendar" : panelSource(p) === "discussed" ? "chat" : "arrow")}</span><div class="t"><a href="${entityHref(e.id)}/${encodeURIComponent(p.panel)}">${esc(p.title ?? p.panel)}</a><div class="ox-sub">Z3 · in full</div></div></div>`
  }
  html += `<span class="ox-lbl" style="margin-top:20px">Provenance</span>`
  const byAgent = new Map<string, number>()
  for (const p of e.pages) byAgent.set(p.agentId, (byAgent.get(p.agentId) ?? 0) + 1)
  for (const [agent, n] of byAgent) {
    const page = e.pages.find(p => p.agentId === agent)!
    html += `<div class="ox-row"><span class="ox-ic">${icon("agent")}</span><div class="t"><a href="/agent/${encodeURIComponent(agent)}/article/${encodeURIComponent(page.article.path)}">${esc(agent)}</a><div class="ox-sub">${n} page${n === 1 ? "" : "s"} · ${e.statements.filter(s => s.page.agentId === agent).length} statements</div></div></div>`
  }
  if (e.pages.length > 1) html += `<div class="ox-row"><span class="ox-ic">${icon("merge")}</span><div class="t"><span class="l">${e.pages.length} pages merged</span><div class="ox-sub">same name, one entity</div></div></div>`
  return html
}

/** Z2: one thing, through the lens of its type. */
export function entityPage(ctx: EntityViewCtx, e: Entity): string {
  const { g } = ctx
  const lens = lensFor(g, e.type)
  const t = g.ontology.types.find(x => x.id === e.type)
  const pinned = g.ontology.sidebar.pins.some(p => g.names.get(normName(p)) === e.id)
  let main = `<div class="ox-bar">${entityCrumbs(g, e)}${zoomBar(2)}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${typeIcon(g.ontology, e.type)}</div><div><h1>${esc(e.title)}</h1><div class="ox-chips">`
  main += `<span class="ox-chip type">${typeIcon(g.ontology, e.type)}${esc(t?.label ?? e.type)}</span>`
  if (t?.schema) main += `<span class="ox-chip mono">${esc(t.schema.includes(" ") || t.schema.includes(":") ? t.schema : `schema.org/${t.schema}`)}</span>`
  if (e.type === "event") main += `<span class="ox-st ${e.importance}">${e.importance}</span>`
  if (pinned) main += `<span class="ox-chip">pinned</span>`
  if (e.pages.length > 1) main += `<span class="ox-chip">${icon("merge")}merged from ${e.pages.length} pages</span>`
  main += `</div></div></div>`

  if (e.review) main += `<div class="ox-card ox-sub" style="border-color:var(--warn,#d97706)">Check the type: ${esc(e.review)}</div>`
  const overview = overviewOf(e)
  const summary = overview ? "" : summaryOf(e)
  if ((overview || summary) && lens[0]?.panel !== "notes") {
    const lead = overview ? `<div class="ox-summary ox-prose">${wikiMd(g, overview)}</div>` : `<p class="ox-summary">${esc(summary)}</p>`
    main += `<section class="ox-card">${lead}<div class="ox-meta"><span>updated ${esc(e.updated || "—")}</span><span>sources: ${e.sources.length}</span><span>${e.statements.length} statements</span></div></section>`
  }
  main += `<div class="ox-grid2">`
  for (const def of lens) {
    const data = panelData(g, e, def, { full: false, readEntries: ctx.readEntries })
    const isNotes = panelSource(def) === "notes"
    main += panelCard(g, e, data, false, isNotes ? notesHtml(g, e, false) : "")
  }
  main += `</div>`
  return layout(e.title, sidebar(g, { pillar: e.pillar, entity: e.id }), main, rail(g, e, lens))
}

/** Z3: one panel in full, paginated. */
export function panelPage(ctx: EntityViewCtx, e: Entity, panelId: string, page: number): string | null {
  const { g } = ctx
  const def = lensFor(g, e.type).find(p => p.panel === panelId)
  if (!def) return null
  const data = panelData(g, e, def, { full: true, page, pageSize: 50, readEntries: ctx.readEntries })
  const title = def.title ?? def.panel
  let main = `<div class="ox-bar">${entityCrumbs(g, e, [{ label: title }])}${zoomBar(3)}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${typeIcon(g.ontology, e.type)}</div><div><h1>${esc(title)}</h1><p>${esc(e.title)} · ${data.total} item${data.total === 1 ? "" : "s"}</p></div></div>`
  const isNotes = panelSource(def) === "notes"
  main += panelCard(g, e, data, true, isNotes ? notesHtml(g, e, true) : "")
  const pages = Math.ceil(data.total / 50)
  if (pages > 1) {
    const base = `${entityHref(e.id)}/${encodeURIComponent(panelId)}`
    main += `<div class="ox-pager">${page > 1 ? `<a href="${base}?page=${page - 1}">← newer</a>` : ""}<span>page ${page} of ${pages}</span>${page < pages ? `<a href="${base}?page=${page + 1}">older →</a>` : ""}</div>`
  }
  return layout(`${title} · ${e.title}`, sidebar(g, { pillar: e.pillar, entity: e.id }), main)
}

/** Z4: one statement with where it comes from. */
export function statementPage(ctx: EntityViewCtx, e: Entity, index: number): string | null {
  const { g } = ctx
  const st = e.statements[index]
  if (!st) return null
  const prop = g.ontology.properties.find(p => p.id === st.property)
  const target = st.target ? g.entities.get(st.target) : undefined
  const meta = st.page.article.meta
  const rows: Array<[string, string]> = [
    ["Subject", `<a href="${entityHref(e.id)}">${esc(e.title)}</a>`],
    ["Property", `${esc(prop?.label ?? st.property)}${prop?.wikidata ? ` <span class="ox-sub">wikidata ${esc(prop.wikidata)}</span>` : ""}`],
    ["Value", target ? `<a href="${entityHref(target.id)}">${esc(target.title)}</a>` : esc(st.value)],
  ]
  if (st.role) rows.push(["Role", esc(st.role)])
  if (st.metric) rows.push(["Metric", esc(st.metric)])
  if (st.since || st.until) rows.push(["True", `${esc(st.since ?? "…")} → ${esc(st.until ?? "now")}`])
  if (st.at) rows.push(["Measured", esc(st.at)])
  rows.push(["Recorded", esc(meta.lastUpdated || meta.created || "—")])
  rows.push(["Source", esc(st.source ?? (meta.sources.length ? `${meta.sources.length} conversation entries` : "not given"))])
  rows.push(["Written by", `${esc(st.page.agentId)} · <a href="/agent/${encodeURIComponent(st.page.agentId)}/article/${encodeURIComponent(st.page.article.path)}">${esc(st.page.article.path)}</a>`])
  rows.push(["Status", st.status ? `<span class="ox-st ${esc(st.status)}">${esc(st.status)}</span>` : "not set"])
  if (st.confirmed_by) rows.push(["Confirmed by", esc(st.confirmed_by)])
  if (st.checked_at) rows.push(["Checked", esc(st.checked_at)])
  rows.push(["Access", esc(st.access ?? meta.access)])
  if (st.note) rows.push(["Note", esc(st.note)])
  const versions = ctx.versions(st.page.agentId, st.page.article.path)
  rows.push(["Past versions", versions.length ? versions.slice(0, 8).map(v => esc(v.timestamp)).join("<br>") : "none saved"])

  let main = `<div class="ox-bar">${entityCrumbs(g, e, [{ label: prop?.label ?? st.property }])}${zoomBar(4)}</div>`
  main += `<div class="ox-head"><div class="ox-avatar">${icon("key")}</div><div><h1>${esc(prop?.label ?? st.property)}</h1><p>${esc(e.title)} → ${esc(target?.title ?? st.value)}</p></div></div>`
  main += `<section class="ox-card">${rows.map(([k, v]) => `<div class="ox-kv"><span class="k">${k}</span><span>${v}</span></div>`).join("")}</section>`
  return layout(`${prop?.label ?? st.property} · ${e.title}`, sidebar(g, { pillar: e.pillar, entity: e.id }), main)
}
