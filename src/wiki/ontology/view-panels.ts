// --- Rendering one lens panel (#811) ---

import type { Entity, WikiGraph } from "./graph"
import type { PanelData, PanelItem } from "./lens"
import { entityHref, esc, icon, typeIcon, typeLabel } from "./view-layout"

const today = (): string => new Date().toISOString().slice(0, 10)

function statusChip(s?: string): string {
  return s ? `<span class="ox-st ${esc(s)}">${esc(s)}</span>` : ""
}

function itemTitle(it: PanelItem): string {
  if (it.private) return `<span class="l"><span class="ox-mask">••••</span> ${icon("lock")}</span>`
  return it.entityId ? `<a href="${entityHref(it.entityId)}">${esc(it.label)}</a>` : `<span class="l">${esc(it.label)}</span>`
}

function itemSub(g: WikiGraph, it: PanelItem): string {
  if (it.sub) return it.sub
  const parts: string[] = []
  if (it.type) parts.push(typeLabel(g.ontology, it.type).toLowerCase())
  if (it.since || it.until) parts.push(`${it.since ?? "…"} → ${it.until ?? "now"}`)
  else if (it.date) parts.push(it.date)
  return parts.join(" · ")
}

function rowHtml(g: WikiGraph, e: Entity, it: PanelItem): string {
  const sub = itemSub(g, it)
  const chips = it.chips.map(c => `<span class="ox-chip">${esc(c)}</span>`).join("")
  const z4 = it.statement !== undefined && it.statement >= 0
    ? `<a class="ox-sub" href="${entityHref(e.id)}/s/${it.statement}" title="Where this comes from (Z4)">Z4</a>` : ""
  return `<div class="ox-row"><span class="ox-ic">${it.type ? typeIcon(g.ontology, it.type) : icon(it.private ? "lock" : "topic")}</span>`
    + `<div class="t">${itemTitle(it)}${sub ? `<div class="ox-sub">${esc(sub)}</div>` : ""}</div>`
    + `<div class="r">${chips}${statusChip(it.status)}${z4}</div></div>`
}

function eventRow(it: PanelItem): string {
  const level = it.importance ?? "normal"
  return `<div class="ox-ev"><span class="d">${esc(it.date ?? "")}</span><span class="ox-st ${level}">${level}</span>`
    + `<span>${it.entityId ? `<a href="${entityHref(it.entityId)}">${esc(it.label)}</a>` : esc(it.label)}</span></div>`
}

function timeline(items: PanelItem[]): string {
  const years = items.flatMap(i => [i.since, i.until]).filter((d): d is string => !!d).map(d => Number(d.slice(0, 4))).filter(Boolean)
  const now = Number(today().slice(0, 4))
  const min = Math.min(...years, now - 1)
  const span = Math.max(1, now + 1 - min)
  const pos = (d: string | undefined, end: boolean): number => {
    if (!d) return end ? 100 : 0
    const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7)) || (end ? 12 : 1)]
    return Math.min(100, Math.max(0, ((y - min) + (m - 1) / 12) / span * 100))
  }
  let html = `<div class="ox-tl-axis"><span></span><span class="yrs"><span>${min}</span><span>${now}</span></span></div>`
  for (const it of items) {
    const left = pos(it.since, false)
    const right = pos(it.until, true)
    const label = `${it.since ?? "…"} → ${it.until ?? "now"}`
    html += `<div class="ox-tl-row"><div class="who">${it.chips.map(esc).join(", ")}<small>${it.entityId ? `<a href="${entityHref(it.entityId)}">${esc(it.label)}</a>` : esc(it.label)}</small></div>`
      + `<div class="ox-track"><i class="${it.until ? "past" : ""}" style="left:${left.toFixed(1)}%;width:${Math.max(4, right - left).toFixed(1)}%" title="${esc(label)}">${esc(label)}</i></div></div>`
  }
  return html
}

/** A panel card. `full` is the Z3 view: no zoom link, minor events unfolded. */
export function panelCard(g: WikiGraph, e: Entity, p: PanelData, full: boolean, notesHtml = ""): string {
  const zin = !full && (p.total > p.items.length || p.def.source === "notes" || p.folded.length)
    ? `<a class="zin" href="${entityHref(e.id)}/${encodeURIComponent(p.def.panel)}">all ${p.total || ""} (Z3) →</a>` : ""
  const isNotes = p.def.source === "notes" || p.def.panel === "notes"
  const count = isNotes ? `${e.pages.length} page${e.pages.length === 1 ? "" : "s"}` : `${p.total} ${p.total === 1 ? "item" : "items"}`
  const note = `<span class="note">${p.ownerOnly ? `${icon("lock")} private to the owner · ` : ""}${count}</span>`
  let body = ""
  if (p.def.source === "notes" || p.def.panel === "notes") {
    body = notesHtml || `<div class="ox-empty">No notes.</div>`
  } else if (p.items.length === 0) {
    body = `<div class="ox-empty">Nothing recorded yet.</div>`
  } else if (p.def.display === "timeline" && p.items.some(i => i.since)) {
    body = timeline(p.items)
  } else if (p.def.source === "history" || p.items.every(i => i.type === "event")) {
    body = p.items.map(eventRow).join("")
  } else {
    body = p.items.map(it => rowHtml(g, e, it)).join("")
  }
  for (const r of p.rollups) body += `<div class="ox-fold">↻ Recurring: ${esc(r)}</div>`
  if (p.folded.length) {
    body += `<details class="ox-fold"><summary>+ ${p.folded.length} minor event${p.folded.length === 1 ? "" : "s"}</summary>${p.folded.slice(0, 20).map(eventRow).join("")}</details>`
  }
  const wide = p.def.display === "timeline" || p.def.source === "notes" || p.def.panel === "notes" ? " wide" : ""
  return `<section class="ox-card${wide}"><div class="ox-card-h"><h2>${esc(p.title)}</h2>${note}${zin}</div>${body}</section>`
}
