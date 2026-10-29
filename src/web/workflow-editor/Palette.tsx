import { Fragment, useEffect, useMemo, useState } from "react"
import { Icon } from "./Icons"
import { PALETTE, TEMPLATES, type PaletteItem, type PaletteSection, type TemplateCard } from "./data"

// --- Palette ---
// The side menu's "Add a step" tab (#1524): drag a step onto the canvas, or
// select it (click, tap, Enter) to drop it in the middle of the view. Template
// cards replace the current workflow wholesale when selected.

export interface PaletteProps {
  onLoadTemplate: (tpl: TemplateCard) => void
  /** Add this step where the view is looking. */
  onAdd: (item: PaletteItem) => void
}

export function Palette({ onLoadTemplate, onAdd }: PaletteProps) {
  const [q, setQ] = useState("")
  const [n8n, setN8n] = useState<PaletteSection[]>([])

  // Your own n8n workflows, listed as steps. n8n already talks to hundreds
  // of services; rather than rebuild any of that, each workflow it exposes
  // over a webhook becomes something you can drop onto the canvas — already
  // pointing at the right URL. Silent when n8n is not configured.
  useEffect(() => {
    let alive = true
    fetch("/api/n8n/workflows")
      .then((r) => r.json())
      .then((d: { workflows?: Array<{ id: string; name: string; active: boolean; webhookUrl: string | null }> }) => {
        if (!alive) return
        const items: PaletteItem[] = (d.workflows ?? [])
          .filter((w) => w.webhookUrl)
          .map((w) => ({
            id: "n8n." + w.id,
            type: "action.callHTTP" as const,
            label: w.name,
            hint: w.active ? "Hands this over to n8n" : "In n8n, but switched off there",
            glyph: "g-action",
            icon: "globe" as const,
            config: { url: w.webhookUrl, method: "POST", body: "{{trigger}}" },
          }))
        setN8n(items.length ? [{ section: "From your n8n", items }] : [])
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const all = useMemo(() => [...PALETTE, ...n8n], [n8n])

  const sections = useMemo(() => {
    if (!q.trim()) return all
    const needle = q.toLowerCase()
    return all.map((s) => ({
      ...s,
      items: s.items.filter((i) =>
        i.label.toLowerCase().includes(needle) ||
        i.hint.toLowerCase().includes(needle) ||
        i.type.includes(needle),
      ),
    })).filter((s) => s.items.length > 0)
  }, [q, all])

  return (
    <div className="pal">
      <div className="pal__search">
        <Icon.search />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a step…" aria-label="Find a step to add" />
        <kbd>/</kbd>
      </div>
      <div className="pal__scroll">
        {sections.map((s) => (
          <Fragment key={s.section}>
            <div className="pal__section">
              <span>{s.section}</span>
              <span className="pal__section-count">{s.items.length.toString().padStart(2, "0")}</span>
            </div>
            {s.items.map((i) => <PaletteItemView key={i.id} item={i} onAdd={onAdd} />)}
          </Fragment>
        ))}

        {!q && (
          <>
            <div className="pal__section">
              <span>Templates</span>
              <span className="pal__section-count">{TEMPLATES.length.toString().padStart(2, "0")}</span>
            </div>
            {TEMPLATES.map((t) => (
              <button type="button" className="pal__tpl" key={t.id} onClick={() => onLoadTemplate(t)}>
                <div className="pal__tpl-dots">
                  {[0, 1, 2].map((i) => <span key={i} className={i < t.dots ? "on" : ""} />)}
                </div>
                <div className="pal__tpl-title">{t.title}</div>
                <div className="pal__tpl-hint">{t.hint}</div>
              </button>
            ))}
          </>
        )}
      </div>
      <div className="pal__foot">
        <Icon.lightning />
        <span>Select a step to add it, or drag it onto the canvas</span>
      </div>
    </div>
  )
}

function PaletteItemView({ item, onAdd }: { item: PaletteItem; onAdd: (item: PaletteItem) => void }) {
  const I = Icon[item.icon] ?? Icon.box
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-wfe-item", JSON.stringify(item))
    e.dataTransfer.effectAllowed = "copy"
    const ghost = document.createElement("div")
    ghost.textContent = item.label
    ghost.style.cssText = "position:absolute;top:-1000px;padding:6px 10px;background:var(--ax-accent);color:var(--ax-bg);border-radius:6px;font:500 12px var(--ax-font);"
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 10, 10)
    setTimeout(() => document.body.removeChild(ghost), 0)
  }
  return (
    <div className="pal__item" draggable onDragStart={onDragStart} role="button" tabIndex={0}
         title={`Add “${item.label}”`}
         onClick={() => onAdd(item)}
         onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAdd(item) } }}>
      <div className={"pal__glyph " + item.glyph}><I /></div>
      <div className="pal__meta">
        <div className="pal__label">{item.label}</div>
        <div className="pal__hint">{item.hint}</div>
      </div>
    </div>
  )
}
