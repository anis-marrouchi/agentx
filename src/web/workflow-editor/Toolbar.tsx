import { Fragment } from "react"
import { Icon } from "./Icons"

export type SaveStatus = "is-saved" | "is-dirty" | "is-running" | "is-validating"

export interface ToolbarProps {
  title: string
  setTitle: (v: string) => void
  status: SaveStatus
  statusLabel?: string
  theme: "dark" | "light"
  setTheme: (t: "dark" | "light") => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onRun: () => void
  running: boolean
  tweaksOpen: boolean
  setTweaksOpen: (v: boolean) => void
  onHelp: () => void
  onLayout: () => void
  workflowIdLabel: string
  paletteOpen: boolean
  setPaletteOpen: (v: boolean) => void
  inspectorOpen: boolean
  setInspectorOpen: (v: boolean) => void
  /** True when editing a draft — gates the "Promote" button and changes the
   *  brand label so the operator sees they're not on the active store. */
  isDraft?: boolean
  /** Move this draft into the active workflow store. Only invoked when
   *  isDraft is true. */
  onPromote?: () => void
}

export function Toolbar(p: ToolbarProps) {
  return (
    <div className="tb">
      <div className="tb__brand">
        <div className="tb__mark">✦</div>
        <div>
          <div className="tb__brand-label">Workflow Editor{p.isDraft ? <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.7 }}>· draft</span> : null}</div>
          <div className="tb__brand-sub">{p.workflowIdLabel}</div>
        </div>
      </div>

      <div className="tb__main">
        <div className="tb__crumbs">
          <a href="/workflows">Workflows</a>
          <span className="sep">/</span>
          <input value={p.title} onChange={(e) => p.setTitle(e.target.value)} />
        </div>
        <span className="tb__sep" />
        <div className={"tb__status " + (p.status)}>
          <span className="dot" />
          {p.statusLabel ?? (p.status === "is-dirty" ? "unsaved" : p.status === "is-running" ? "running" : p.status === "is-validating" ? "validating…" : "saved")}
        </div>
        <div className="tb__spacer" />

        <button className={"btn btn--ghost-icon" + (p.paletteOpen ? " is-active" : "")}
                title={p.paletteOpen ? "Hide palette" : "Show palette"}
                onClick={() => p.setPaletteOpen(!p.paletteOpen)}><Icon.panelLeft /></button>
        <button className={"btn btn--ghost-icon" + (p.inspectorOpen ? " is-active" : "")}
                title={p.inspectorOpen ? "Hide inspector" : "Show inspector"}
                onClick={() => p.setInspectorOpen(!p.inspectorOpen)}><Icon.panelRight /></button>
        <span className="tb__sep" />
        <button className="btn btn--ghost-icon" title="Undo (⌘Z)" onClick={p.onUndo} disabled={!p.canUndo}><Icon.undo /></button>
        <button className="btn btn--ghost-icon" title="Redo (⌘⇧Z)" onClick={p.onRedo} disabled={!p.canRedo}><Icon.redo /></button>
        <button className="btn btn--ghost-icon" title="Auto layout" onClick={p.onLayout}><Icon.layout /></button>
        <button className="btn btn--ghost-icon" title="Keyboard shortcuts" onClick={p.onHelp}><Icon.kbd /></button>
        <button className={"btn btn--ghost-icon" + (p.tweaksOpen ? " is-active" : "")} title="Tweaks" onClick={() => p.setTweaksOpen(!p.tweaksOpen)}><Icon.gear /></button>
        <button className="btn btn--ghost-icon" title="Toggle theme" onClick={() => p.setTheme(p.theme === "dark" ? "light" : "dark")}>
          {p.theme === "dark" ? <Icon.sun /> : <Icon.moon />}
        </button>
      </div>

      <div className="tb__actions">
        <button className="btn btn--outline" onClick={p.onSave}><Icon.save /> Save</button>
        {p.isDraft && p.onPromote
          ? <button className="btn btn--primary" onClick={p.onPromote} title="Move this draft into the active workflow store">Promote</button>
          : <button className="btn btn--primary" onClick={p.onRun}>
              {p.running ? <><Icon.stop2 /> Stop</> : <><Icon.run /> Run preview</>}
            </button>}
      </div>
    </div>
  )
}

// --- Run preview panel --------------------------------------

export interface RunStep {
  nodeId: string | null
  edgeId: string | null
  title: string | null
  body: string | null
}

export interface RunPanelProps {
  running: boolean
  script: RunStep[]
  cursor: number
  onStop: () => void
}

export function RunPanel({ running, script, cursor, onStop }: RunPanelProps) {
  if (!running) return null
  const shown = script.filter((s) => s.nodeId)
  return (
    <div className="run">
      <div className="run__head">
        <Icon.lightning />
        <div className="run__title">Live run</div>
        <span className="run__chip"><span className="dot" /> streaming</span>
        <button className="btn btn--ghost-icon" onClick={onStop} style={{ height: 24, width: 24 }}><Icon.x /></button>
      </div>
      <div className="run__body">
        {shown.map((step, idx) => {
          const scriptIdx = script.indexOf(step)
          const isDone    = scriptIdx < cursor
          const cls = ["run__step"]
          if (isDone) cls.push("is-done")
          if (scriptIdx === cursor) cls.push("is-current")
          return (
            <div key={idx} className={cls.join(" ")}>
              <div className="run__marker">{isDone ? <Icon.check /> : idx + 1}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="run__step-title">{step.title}</div>
                {step.body && <div className="run__step-body" dangerouslySetInnerHTML={{ __html: step.body }} />}
              </div>
            </div>
          )
        })}
      </div>
      <div className="run__foot">
        <span>{Math.min(cursor + 1, script.length)}/{script.length}</span>
        <span>{script.length ? Math.round((cursor + 1) / script.length * 100) : 0}%</span>
      </div>
    </div>
  )
}

// --- Tweaks panel -------------------------------------------

const HUES = [
  { h: 255, name: "indigo" },
  { h: 220, name: "blue" },
  { h: 180, name: "teal" },
  { h: 145, name: "green" },
  { h: 70,  name: "amber" },
  { h: 28,  name: "orange" },
  { h: 330, name: "pink" },
]

export interface TweaksProps {
  open: boolean
  setOpen: (v: boolean) => void
  theme: "dark" | "light"
  setTheme: (t: "dark" | "light") => void
  density: "compact" | "cozy" | "roomy"
  setDensity: (d: "compact" | "cozy" | "roomy") => void
  hue: number
  setHue: (h: number) => void
}

export function Tweaks(p: TweaksProps) {
  if (!p.open) return null
  return (
    <div className="tweaks">
      <div className="tweaks__head">
        <span>Tweaks</span>
        <button className="btn btn--ghost-icon" style={{ height: 22, width: 22 }} onClick={() => p.setOpen(false)}><Icon.x /></button>
      </div>
      <div className="tweaks__body">
        <div className="tweaks__row">
          <label>Theme</label>
          <div className="tweaks__opts">
            {(["dark", "light"] as const).map((t) => (
              <button key={t} className={p.theme === t ? "on" : ""} onClick={() => p.setTheme(t)}>{t}</button>
            ))}
          </div>
        </div>
        <div className="tweaks__row">
          <label>Density</label>
          <div className="tweaks__opts">
            {(["compact", "cozy", "roomy"] as const).map((d) => (
              <button key={d} className={p.density === d ? "on" : ""} onClick={() => p.setDensity(d)}>{d}</button>
            ))}
          </div>
        </div>
        <div className="tweaks__row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
          <label>Accent hue</label>
          <div className="tweaks__hue">
            {HUES.map((h) => (
              <button key={h.h} title={h.name}
                className={p.hue === h.h ? "on" : ""}
                style={{ background: `oklch(0.70 0.16 ${h.h})` }}
                onClick={() => p.setHue(h.h)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Keyboard-shortcut overlay ------------------------------

export function KbdOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  const rows: Array<[string, string]> = [
    ["Save workflow", "⌘S"], ["Undo / Redo", "⌘Z / ⌘⇧Z"],
    ["Delete selection", "Delete"], ["Duplicate node", "⌘D"],
    ["Run preview", "⌘⏎"],
    ["Focus search", "/"], ["Fit view", "F"],
    ["Close panels", "Esc"],
  ]
  return (
    <div className="kbd-overlay" onClick={onClose}>
      <div className="kbd-card" onClick={(e) => e.stopPropagation()}>
        <h3>Keyboard shortcuts</h3>
        {rows.map(([l, k]) => (
          <div className="row" key={l}>
            <span>{l}</span>
            <span>
              {k.split(" ").map((x, i) => (
                <Fragment key={i}>
                  {x.includes("/") ? x.split("/").map((a, j) => <Fragment key={j}>{j > 0 && " / "}<kbd>{a.trim()}</kbd></Fragment>) : <kbd>{x}</kbd>}{" "}
                </Fragment>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
