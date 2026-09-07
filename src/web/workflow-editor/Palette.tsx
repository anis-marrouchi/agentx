import { Fragment, useEffect, useMemo, useState } from "react"
import { Icon } from "./Icons"
import { PALETTE, TEMPLATES, type PaletteItem, type PaletteSection, type TemplateCard } from "./data"

// --- Palette ---
// Drag-and-drop source for adding nodes, plus template cards that replace
// the current workflow wholesale when clicked.

export interface PaletteProps {
  onLoadTemplate: (tpl: TemplateCard) => void
}

export function Palette({ onLoadTemplate }: PaletteProps) {
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
    <aside className="pal">
      <div className="pal__search">
        <Icon.search />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search nodes…" />
        <kbd>/</kbd>
      </div>
      <div className="pal__scroll">
        {sections.map((s) => (
          <Fragment key={s.section}>
            <div className="pal__section">
              <span>{s.section}</span>
              <span className="pal__section-count">{s.items.length.toString().padStart(2, "0")}</span>
            </div>
            {s.items.map((i) => <PaletteItemView key={i.id} item={i} />)}
          </Fragment>
        ))}

        {!q && (
          <>
            <div className="pal__section">
              <span>Templates</span>
              <span className="pal__section-count">{TEMPLATES.length.toString().padStart(2, "0")}</span>
            </div>
            {TEMPLATES.map((t) => (
              <div className="pal__tpl" key={t.id} onClick={() => onLoadTemplate(t)}>
                <div className="pal__tpl-dots">
                  {[0, 1, 2].map((i) => <span key={i} className={i < t.dots ? "on" : ""} />)}
                </div>
                <div className="pal__tpl-title">{t.title}</div>
                <div className="pal__tpl-hint">{t.hint}</div>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="pal__foot">
        <Icon.lightning />
        <span>Drag items onto the canvas</span>
      </div>
    </aside>
  )
}

function PaletteItemView({ item }: { item: PaletteItem }) {
  const I = Icon[item.icon] ?? Icon.box
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData("application/x-wfe-item", JSON.stringify(item))
    e.dataTransfer.effectAllowed = "copy"
    const ghost = document.createElement("div")
    ghost.textContent = item.label
    ghost.style.cssText = "position:absolute;top:-1000px;padding:6px 10px;background:var(--accent);color:#fff;border-radius:6px;font:500 12px 'Space Grotesk';"
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 10, 10)
    setTimeout(() => document.body.removeChild(ghost), 0)
  }
  return (
    <div className="pal__item" draggable onDragStart={onDragStart}>
      <div className={"pal__glyph " + item.glyph}><I /></div>
      <div className="pal__meta">
        <div className="pal__label">{item.label}</div>
        <div className="pal__hint">{item.hint}</div>
      </div>
    </div>
  )
}
