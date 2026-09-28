import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { fmtRelative, type FleetDispatch, type FleetSnapshot } from "./api"
import { buildTransit, headline, type Line, type Transit } from "./transit"
import { layoutNetwork } from "./transit-layout"
import { TransitMap } from "./TransitMap"
import { ChannelCard, HopCard, selKey, StationCard, type CardCtx, type Sel } from "./MapCards"
import { TrainPanel } from "./TrainPanel"

// Map perspective — the fleet as a transit map. Desktop: line board, map,
// detail drawer. Phone (< 640 px): departures board → one line → sheet.
// Channels, stations, hops and trains all open a card (#267).

const LINE_STATUS: Record<Line["state"], string> = { delays: "Delays", good: "Good service", quiet: "Quiet" }

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
  const [sel, setSel] = useState<Sel | null>(null)
  // Trains whose long routes are drawn in full ("+n" expanded).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const transit = useMemo(() => buildTransit(snap, dispatches), [snap, dispatches])
  const mesh = useMemo(() => meshAgentsOf(snap, dispatches), [snap, dispatches])
  const names = useMemo(() => new Map(snap.agents.map((a) => [a.id, a.name])), [snap])
  const agentName = useCallback((id: string) => names.get(id) || id, [names])
  const byId = useMemo(() => new Map([...snap.dispatches, ...dispatches].map((d) => [d.id, d])), [snap, dispatches])
  const lineId = narrow ? phoneLine : null

  const net = useMemo(() => layoutNetwork(transit, {
    orientation: narrow ? "vertical" : "horizontal", showIdle, meshAgents: mesh.agents, agentName,
    allAgents: snap.agents.map((a) => a.id), lineId: lineId ?? undefined,
    districtName: mesh.peers.join(", ") || "mesh", expanded,
  }), [transit, narrow, showIdle, mesh, agentName, snap, lineId, expanded])

  const onSelect = useCallback((s: Sel) => setSel(s), [])
  const onExpand = useCallback((ids: string[]) => setExpanded((cur) => new Set([...cur, ...ids])), [])
  const close = useCallback(() => setSel(null), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSel(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const ctx: CardCtx = { transit, snap, byId, agentName, onSelect, onOpenItem }
  const idleHidden = showIdle ? 0 : snap.agents.filter((a) => !net.nodes.some((n) => n.id === `st:${a.id}`)).length
  const quiet = transit.lines.filter((l) => l.state === "quiet").map((l) => l.name)
  const map = (orientation: "horizontal" | "vertical", fitWidth?: boolean) => (
    <TransitMap net={net} orientation={orientation} focus={fitWidth ? null : focus} selected={selKey(sel)}
      onSelect={onSelect} onExpand={onExpand} onPane={close} fitWidth={fitWidth} />
  )

  let panel: React.ReactNode = null
  if (sel?.kind === "train") {
    const train = transit.trains.find((t) => t.id === sel.id)
    if (train) panel = <TrainPanel train={train} line={transit.lines.find((l) => l.id === train.lineId)} ctx={ctx} sheet={narrow} onClose={close} />
  } else if (sel?.kind === "channel") panel = <ChannelCard id={sel.id} ctx={ctx} sheet={narrow} onClose={close} />
  else if (sel?.kind === "station") panel = <StationCard id={sel.id} ctx={ctx} sheet={narrow} onClose={close} />
  else if (sel?.kind === "hop") panel = <HopCard sel={sel} ctx={ctx} sheet={narrow} onClose={close} />

  if (narrow) {
    const pl = transit.lines.find((l) => l.id === phoneLine)
    return (
      <div className="tm-wrap is-phone" ref={wrap}>
        {!pl ? <PhoneHome transit={transit} windowH={windowH} onLine={(id) => { setPhoneLine(id); setSel(null) }} /> : (
          <div className="tm-phone tm-phone--line">
            <div className="tm-phone__bar">
              <button className="tm-back" onClick={() => { setPhoneLine(null); setSel(null) }} aria-label="Back">‹</button>
              <Code line={pl} /><h2>{pl.name}</h2>
            </div>
            {pl.state !== "quiet" && (
              <div className={`tm-banner is-${pl.state}`}><Status line={pl} /><span>{pl.reason || `${pl.trains.length} trains in the last ${windowH}h`}</span></div>
            )}
            {map("vertical", true)}
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
          {net.nodes.some((n) => n.kind === "trains") ? map("horizontal") : <div className="empty">No trains in the last {windowH}h.</div>}
          <div className="tm-foot">
            <button className={"tm-chip" + (showIdle ? " is-on" : "")} onClick={() => setShowIdle(!showIdle)}>
              {showIdle ? "Hide idle stations" : `${idleHidden} idle stations hidden`}
            </button>
            {expanded.size > 0 && <button className="tm-chip is-on" onClick={() => setExpanded(new Set())}>Collapse long routes</button>}
            {quiet.length > 0 && <span className="tm-chip">Quiet lines: {quiet.join(" · ")}</span>}
          </div>
        </div>
        {panel}
      </div>
    </div>
  )
}
