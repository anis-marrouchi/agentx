import { Fragment } from "react"
import { Icon } from "./Icons"

export type SaveStatus = "is-saved" | "is-dirty" | "is-running" | "is-validating"

export interface ToolbarProps {
  title: string
  setTitle: (v: string) => void
  status: SaveStatus
  statusLabel?: string
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onSave: () => void
  onRun: () => void
  running: boolean
  onHelp: () => void
  onLayout: () => void
  onFit: () => void
  /** Back to the Wall's Workflows page. */
  onBack: () => void
  menuOpen: boolean
  setMenuOpen: (v: boolean) => void
  /** False for a viewer who is not the owner: no Save. */
  canSave: boolean
}

// One bar over both columns (#1524). The Wall around it has the logo, the
// nav and the light/dark switch, so the editor no longer draws its own.
export function Toolbar(p: ToolbarProps) {
  return (
    <div className="tb" role="toolbar" aria-label="Workflow editor">
      <div className="tb__main">
        <button type="button" className={"btn btn--ghost-icon tb__menu" + (p.menuOpen ? " is-active" : "")}
                aria-expanded={p.menuOpen} aria-controls="wfe-menu"
                title={(p.menuOpen ? "Hide" : "Show") + " the side menu ([)"}
                aria-label={(p.menuOpen ? "Hide" : "Show") + " the side menu"}
                onClick={() => p.setMenuOpen(!p.menuOpen)}><Icon.panelLeft /></button>
        <div className="tb__crumbs">
          <button type="button" className="tb__back" onClick={p.onBack} title="Back to Workflows">Workflows</button>
          <span className="sep" aria-hidden="true">/</span>
          <input value={p.title} aria-label="Workflow title" onChange={(e) => p.setTitle(e.target.value)} />
        </div>
        <div className={"tb__status " + (p.status)} role="status">
          <span className="dot" />
          {p.statusLabel ?? (p.status === "is-dirty" ? "unsaved" : p.status === "is-running" ? "running" : p.status === "is-validating" ? "checking…" : "saved")}
        </div>
        <div className="tb__spacer" />
        <button type="button" className="btn btn--ghost-icon tb__opt" title="Undo (⌘Z)" aria-label="Undo" onClick={p.onUndo} disabled={!p.canUndo}><Icon.undo /></button>
        <button type="button" className="btn btn--ghost-icon tb__opt" title="Redo (⌘⇧Z)" aria-label="Redo" onClick={p.onRedo} disabled={!p.canRedo}><Icon.redo /></button>
        <button type="button" className="btn btn--ghost tb__arrange" title="Arrange the steps left to right (L)" onClick={p.onLayout}><Icon.layout /><span>Arrange</span></button>
        <button type="button" className="btn btn--ghost-icon tb__opt" title="Fit the workflow in view (F)" aria-label="Fit in view" onClick={p.onFit}><Icon.fit /></button>
        <button type="button" className="btn btn--ghost-icon tb__opt" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={p.onHelp}><Icon.kbd /></button>
      </div>

      <div className="tb__actions">
        {p.canSave && <button type="button" className="btn btn--outline" onClick={p.onSave}><Icon.save /> <span>Save</span></button>}
        <button type="button" className="btn btn--primary tb__run" onClick={p.onRun} title="Walk through the steps without running them">
          {p.running ? <><Icon.stop2 /> <span>Stop</span></> : <><Icon.run /> <span>Preview</span></>}
        </button>
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

// --- Keyboard-shortcut overlay ------------------------------

export function KbdOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  const rows: Array<[string, string]> = [
    ["Save workflow", "⌘S"], ["Undo / Redo", "⌘Z / ⌘⇧Z"],
    ["Delete selection", "Delete"], ["Duplicate step", "⌘D"],
    ["Move the selected step", "← → ↑ ↓"],
    ["Arrange the steps", "L"], ["Fit in view", "F"],
    ["Show or hide the side menu", "["],
    ["Preview", "⌘⏎"],
    ["Find a step to add", "/"],
    ["Close this", "Esc"],
  ]
  return (
    <div className="kbd-overlay" onClick={onClose}>
      <div className="kbd-card" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
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
