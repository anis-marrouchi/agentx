import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fmtRelative, fmtTime, type FleetDispatch, type FleetSnapshot } from "./api"
import { buildTransit, headline, routeOf, type Line, type Train, type Transit } from "./transit"
import { layoutNetwork } from "./transit-layout"
import { TransitMap } from "./TransitMap"

// Map perspective — the fleet as a transit map. Desktop: line board, map,
// train drawer. Phone (< 640 px): departures board → one line → train sheet.

const LINE_STATUS: Record<Line["state"], string> = { delays: "Delays", good: "Good service", quiet: "Quiet" }
const TRAIN_STATUS: Record<Train["state"], string> = {
  delayed: "Delays", running: "Running", held: "Held", review: "In review", delivered: "Delivered", done: "Done",
}

function useNarrow(ref: React.RefObject<HTMLDivElement | null>): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 640)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 640))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return narrow
}

/** Agents whose work ran mostly on a mesh peer → the remote district. */
function meshAgentsOf(snap: FleetSnapshot, dispatches: FleetDispatch[]): { agents: Set<string>; peers: string[] } {
  const hits = new Map<string, Map<string, number>>()
  for (const d of dispatches) {
    if (!d.nodeId) continue
    const m = hits.get(d.agentId) ?? new Map<string, number>()
    m.set(d.nodeId, (m.get(d.nodeId) || 0) + 1)
    hits.set(d.agentId, m)
  }
  const agents = new Set<string>()
  const peers = new Set<string>()
  for (const [a, m] of hits) {
    const home = [...m.entries()].sort((x, y) => y[1] - x[1])[0][0]
    if (snap.localNodeId && home !== snap.localNodeId) { agents.add(a); peers.add(home) }
  }
  return { agents, peers: [...peers] }
}

const Status = ({ line }: { line: Line }) => <span className={`tm-status is-${line.state}`}>{LINE_STATUS[line.state]}</span>
const Code = ({ line }: { line: Line }) => <span className="tm-code" style={{ ["--lc" as string]: line.color }}>{line.code}</span>

function LineBoard({ lines, focus, onPick }: { lines: Line[]; focus: string | null; onPick: (id: string) => void }) {
  return (
    <div className="tm-board">
      {lines.map((l) => (
        <button key={l.id} className={`tm-board__line is-${l.state}` + (focus === l.id ? " is-focus" : "")} onClick={() => onPick(l.id)}>
          <Code line={l} />
          <span className="tm-board__name"><b>{l.name}</b>{l.reason && <small>{l.reason}</small>}</span>
          <span className="tm-board__ct">{l.trains.length}</span>
          <Status line={l} />
        </button>
      ))}
    </div>
  )
}

function TrainPanel(props: {
  train: Train; line: Line | undefined; snap: FleetSnapshot; agentName: (id: string) => string
  byId: Map<string, FleetDispatch>; onClose: () => void; onOpenItem: (d: FleetDispatch) => void; sheet?: boolean
  onTrain: (t: Train) => void
}) {
  const { train: t, line, snap, agentName, byId, onClose, onOpenItem, sheet, onTrain } = props
  const others = (line?.trains ?? []).filter((x) => x.id !== t.id).slice(0, 4)
  const gitlab = snap.forges?.gitlab?.replace(/\/+$/, "")
  const project = t.items.find((i) => i.url)?.url?.match(/^https?:\/\/[^/]+\/(.+?)\/-\//)?.[1]
  const latest = byId.get(t.dispatchIds[t.dispatchIds.length - 1])
  let cta: { label: string; href?: string; run?: FleetDispatch } | null = null
  if (t.failedPipelines.length === 1) cta = { label: "Open failed pipeline", href: t.failedPipelines[0] }
  else if (t.failedPipelines.length > 1) cta = {
    label: `Open ${t.failedPipelines.length} failed pipelines`,
    href: gitlab && project ? `${gitlab}/${project}/-/pipelines?scope=all&status=failed` : t.failedPipelines[0],
  }
  else if (t.link) cta = { label: t.items[0].ref?.startsWith("#") ? "Open issue" : "Open MR", href: t.link }
  else if (latest) cta = { label: "Open run details", run: latest }

  return (
    <aside className={"tm-panel" + (sheet ? " is-sheet" : "")}>
      {sheet && <span className="tm-panel__grip" />}
      <div className="tm-panel__kick">
        <span>Train · {line?.name ?? t.lineId}</span>
        <button className="tm-x" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="tm-panel__hd">
        <h3>{t.title}</h3>
        <span className={`tm-badge is-${t.state}`}>{TRAIN_STATUS[t.state]}</span>
      </div>
      <div className="tm-route">
        {routeOf(t, line, agentName).map((r, i, all) => (
          <span key={i} className="tm-route__stop">
            {i > 0 && <i>›</i>}
            <span className={"tm-chip" + (i === all.length - 1 ? " is-line" : "")} style={i === all.length - 1 ? { ["--lc" as string]: line?.color } : undefined}>{r}</span>
          </span>
        ))}
      </div>
      <div className="tm-panel__who">Started by {t.startedBy} · {fmtTime(t.startedAt)} · last activity {fmtRelative(t.lastAt)}</div>
      {t.reason && (
        <div className={`tm-reason is-${t.state}`}>
          <b>{t.state === "held" ? "Held" : t.failedPipelines.length ? "Builds failing" : "Stopped"}</b>
          <span>{t.reason}</span>
        </div>
      )}
      <div className="tm-items">
        {t.items.map((it) => {
          const d = byId.get(it.dispatchId)
          return (
            <div key={it.key} className="tm-item" onClick={() => d && onOpenItem(d)}>
              {it.ref && <b className="mono">{it.ref}</b>}
              <span className="tm-item__t">{it.title}</span>
              <span className={`tm-pill is-${it.status.tone}`}>{it.status.label}</span>
              {it.url
                ? <a href={it.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{it.ref?.startsWith("#") ? "Issue" : "MR"} ›</a>
                : <span className="tm-item__go">Run ›</span>}
            </div>
          )
        })}
      </div>
      {others.length > 0 && (
        <>
          <div className="tm-panel__sec">Also on this line</div>
          <div className="tm-also">
            {others.map((o) => (
              <button key={o.id} onClick={() => onTrain(o)}>
                <span className={`tm-badge is-${o.state} is-sm`}>{TRAIN_STATUS[o.state]}</span>
                <b className="mono">{o.tag}</b> <span>{o.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ flex: 1 }} />
      {cta && (cta.href
        ? <a className="tm-cta" href={cta.href} target="_blank" rel="noreferrer">{cta.label}</a>
        : <button className="tm-cta" onClick={() => cta!.run && onOpenItem(cta!.run)}>{cta.label}</button>)}
    </aside>
  )
}

function PhoneHome({ transit, windowH, onLine }: { transit: Transit; windowH: number; onLine: (id: string) => void }) {
  const active = transit.lines.filter((l) => l.trains.length)
  const delivered = transit.trains.filter((t) => t.state === "delivered").sort((a, b) => b.lastAt - a.lastAt)[0]
  return (
    <div className="tm-phone">
      <h2>{headline(transit.lines)}</h2>
      <p className="tm-phone__sub">{transit.trains.length} trains on {active.length} {active.length === 1 ? "line" : "lines"} · last {windowH}h</p>
      <div className="tm-deps">
        <div className="tm-deps__hd"><span>Line</span><span>Trains</span><span>Status</span></div>
        {transit.lines.map((l) => (
          <button key={l.id} className={`tm-dep is-${l.state}`} onClick={() => onLine(l.id)} disabled={!l.trains.length}>
            <Code line={l} />
            <b className="tm-dep__name">{l.name}</b>
            <span className="tm-dep__ct">{l.trains.length}</span>
            <Status line={l} />
            {l.reason && <small className="tm-dep__why">{l.reason} ›</small>}
          </button>
        ))}
      </div>
      {delivered && (
        <div className="tm-delivered">
          <span className="tm-delivered__ok">✓</span>
          <span><b>{delivered.tag} {delivered.label}</b><small>{transit.lines.find((l) => l.id === delivered.lineId)?.name} · delivered {fmtRelative(delivered.lastAt)}</small></span>
        </div>
      )}
    </div>
  )
}

export function MapPerspective(props: {
  snap: FleetSnapshot; dispatches: FleetDispatch[]; windowH: number
  onOpenItem: (d: FleetDispatch) => void
}) {
  const { snap, dispatches, windowH, onOpenItem } = props
  const wrap = useRef<HTMLDivElement>(null)
  const narrow = useNarrow(wrap)
  const [showIdle, setShowIdle] = useState(false)
  const [focus, setFocus] = useState<string | null>(null)
  const [phoneLine, setPhoneLine] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)

  const transit = useMemo(() => buildTransit(snap, dispatches), [snap, dispatches])
  const mesh = useMemo(() => meshAgentsOf(snap, dispatches), [snap, dispatches])
  const names = useMemo(() => new Map(snap.agents.map((a) => [a.id, a.name])), [snap])
  const agentName = useCallback((id: string) => names.get(id) || id, [names])
  const byId = useMemo(() => new Map(dispatches.map((d) => [d.id, d])), [dispatches])
  const lineId = narrow ? phoneLine : null

  const net = useMemo(() => layoutNetwork(transit, {
    orientation: narrow ? "vertical" : "horizontal", showIdle, meshAgents: mesh.agents, agentName,
    allAgents: snap.agents.map((a) => a.id), lineId: lineId ?? undefined,
    districtName: mesh.peers.join(", ") || "mesh",
  }), [transit, narrow, showIdle, mesh, agentName, snap, lineId])

  const train = transit.trains.find((t) => t.id === selId) ?? null
  const line = train ? transit.lines.find((l) => l.id === train.lineId) : undefined
  const onTrain = useCallback((t: Train) => setSelId(t.id), [])
  const idleHidden = showIdle ? 0 : snap.agents.filter((a) => !net.nodes.some((n) => n.id === `st:${a.id}`)).length
  const quiet = transit.lines.filter((l) => l.state === "quiet").map((l) => l.name)

  const panel = train && (
    <TrainPanel
      train={train} line={line} snap={snap} agentName={agentName} byId={byId} sheet={narrow}
      onClose={() => setSelId(null)} onOpenItem={onOpenItem} onTrain={onTrain}
    />
  )

  if (narrow) {
    const pl = transit.lines.find((l) => l.id === phoneLine)
    return (
      <div className="tm-wrap is-phone" ref={wrap}>
        {!pl ? <PhoneHome transit={transit} windowH={windowH} onLine={(id) => { setPhoneLine(id); setSelId(null) }} /> : (
          <div className="tm-phone tm-phone--line">
            <div className="tm-phone__bar">
              <button className="tm-back" onClick={() => { setPhoneLine(null); setSelId(null) }} aria-label="Back">‹</button>
              <Code line={pl} /><h2>{pl.name}</h2>
            </div>
            {pl.state !== "quiet" && (
              <div className={`tm-banner is-${pl.state}`}><Status line={pl} /><span>{pl.reason || `${pl.trains.length} trains in the last ${windowH}h`}</span></div>
            )}
            <TransitMap net={net} orientation="vertical" focus={null} selected={selId} onTrain={onTrain} onPane={() => setSelId(null)} fitWidth />
            <div className="tm-summary">
              {pl.counts.delayed > 0 && <span className="tm-pill is-warn">! {pl.counts.delayed} delayed</span>}
              {pl.counts.running > 0 && <span className="tm-pill is-live">▶ {pl.counts.running} running</span>}
              {pl.counts.held > 0 && <span className="tm-pill is-held">Ⅱ {pl.counts.held} held</span>}
              {pl.counts.delivered + pl.counts.done > 0 && <span className="tm-pill is-muted">✓ {pl.counts.delivered + pl.counts.done} delivered</span>}
              <span className="mono">last {windowH}h</span>
            </div>
            {panel}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="tm-wrap" ref={wrap}>
      <LineBoard lines={transit.lines} focus={focus} onPick={(id) => setFocus(focus === id ? null : id)} />
      <div className="tm-body">
        <div className="tm-main">
          {net.nodes.some((n) => n.kind === "trains")
            ? <TransitMap net={net} orientation="horizontal" focus={focus} selected={selId} onTrain={onTrain} onPane={() => setSelId(null)} />
            : <div className="empty">No trains in the last {windowH}h.</div>}
          <div className="tm-foot">
            <button className={"tm-chip" + (showIdle ? " is-on" : "")} onClick={() => setShowIdle(!showIdle)}>
              {showIdle ? "Hide idle stations" : `${idleHidden} idle stations hidden`}
            </button>
            {quiet.length > 0 && <span className="tm-chip">Quiet lines: {quiet.join(" · ")}</span>}
          </div>
        </div>
        {panel}
      </div>
    </div>
  )
}
