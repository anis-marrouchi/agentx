import { useState, type ReactNode } from "react"
import { fmtRelative, fmtTime, type FleetDispatch, type FleetSnapshot } from "./api"
import { channelLabel, gist, runStatus, STARTER_KIND, type Hop, type Train, type Transit } from "./transit"

// Detail cards for everything on the map (#267): an initiator, a channel, a
// station, a hop on the line. The train card is TrainPanel.tsx. Every card shows
// bounded previews only; the full text stays behind "Open run details".

export type Sel =
  | { kind: "train"; id: string }
  | { kind: "starter"; id: string }
  | { kind: "channel"; id: string }
  | { kind: "station"; id: string }
  | { kind: "hop"; from: string | null; to: string; lineId?: string; dispatchId?: string | null }

/** Stable key for the selection, to highlight what is open. */
export function selKey(s: Sel | null): string | null {
  if (!s) return null
  return s.kind === "hop" ? `hop:${s.from ?? ""}|${s.to}|${s.lineId ?? ""}|${s.dispatchId ?? ""}` : `${s.kind}:${s.id}`
}

export interface CardCtx {
  transit: Transit
  snap: FleetSnapshot
  /** Every run in the window, by id (not only the filtered ones). */
  byId: Map<string, FleetDispatch>
  agentName: (id: string) => string
  onSelect: (s: Sel) => void
  onOpenItem: (d: FleetDispatch) => void
}

export function nodeLabel(snap: FleetSnapshot, nodeId: string | null | undefined): string {
  if (!nodeId) return ""
  return nodeId === snap.localNodeId ? `${nodeId} (this node)` : `${nodeId} (mesh peer)`
}

export function Shell(props: { kick: string; title: string; badge?: ReactNode; sheet?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <aside className={"tm-panel" + (props.sheet ? " is-sheet" : "")} aria-label={`${props.kick}: ${props.title}`}>
      {props.sheet && <span className="tm-panel__grip" />}
      <div className="tm-panel__kick">
        <span>{props.kick}</span>
        <button className="tm-x" onClick={props.onClose} aria-label="Close">✕</button>
      </div>
      <div className="tm-panel__hd"><h3>{props.title}</h3>{props.badge}</div>
      {props.children}
    </aside>
  )
}

/** A preview clipped to two lines, opened in place on request. */
export function Message({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (!text) return <p className="tm-msg is-empty">No message text recorded.</p>
  const long = text.length > 120
  return (
    <div className="tm-msg">
      <p className={open || !long ? "" : "is-clamped"}>{text}</p>
      {long && <button className="tm-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Show less" : "Show more"}</button>}
    </div>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="tm-empty">{children}</p>

const trainCount = (n: number) => <span className="tm-badge is-sm">{n} {n === 1 ? "train" : "trains"}</span>

/** The trains an initiator or a channel started, newest first. */
function Started({ trains, ctx, detail }: { trains: Train[]; ctx: CardCtx; detail: (t: Train) => string }) {
  return (
    <>
      <div className="tm-rows">
        {trains.slice(0, 6).map((t) => (
          <div key={t.id} className="tm-row">
            <button className="tm-row__main" onClick={() => ctx.onSelect({ kind: "train", id: t.id })}>
              <b className="mono">{t.tag}</b>
              <span className="tm-row__t">{t.title.startsWith(t.tag) ? t.title.slice(t.tag.length).trim() : t.title}</span>
              <small>{[detail(t), t.startedBy, fmtTime(t.startedAt)].join(" · ")}</small>
            </button>
            {t.link && <a className="tm-link" href={t.link} target="_blank" rel="noreferrer">Open ›</a>}
          </div>
        ))}
      </div>
      {trains.length > 6 && <Empty>{trains.length - 6} older trains are on their lines.</Empty>}
    </>
  )
}

const newestFirst = (a: Train, b: Train) => b.startedAt - a.startedAt

/** Initiator: what this person, AgentX or external system started. */
export function StarterCard({ id, ctx, sheet, onClose }: { id: string; ctx: CardCtx; sheet?: boolean; onClose: () => void }) {
  const trains = ctx.transit.trains.filter((t) => t.starter.id === id).sort(newestFirst)
  const starter = trains[0]?.starter
  return (
    <Shell kick={starter ? `Initiator · ${STARTER_KIND[starter.kind]}` : "Initiator"} title={starter?.name ?? id} sheet={sheet} onClose={onClose}
      badge={trainCount(trains.length)}>
      {id === "unknown" && <div className="tm-panel__who">The sender matches nobody in your people list, so no name is guessed.</div>}
      <div className="tm-panel__sec">What it started</div>
      {!trains.length && <Empty>Nothing started in this window.</Empty>}
      <Started trains={trains} ctx={ctx} detail={(t) => channelLabel(t.channel)} />
    </Shell>
  )
}

/** Channel: the events that started trains here. */
export function ChannelCard({ id, ctx, sheet, onClose }: { id: string; ctx: CardCtx; sheet?: boolean; onClose: () => void }) {
  const trains = ctx.transit.trains.filter((t) => t.channel === id).sort(newestFirst)
  return (
    <Shell kick="Channel" title={channelLabel(id)} sheet={sheet} onClose={onClose} badge={trainCount(trains.length)}>
      <div className="tm-panel__sec">What came in</div>
      {!trains.length && <Empty>Nothing started on {channelLabel(id)} in this window.</Empty>}
      <Started trains={trains} ctx={ctx} detail={(t) => (t.originId && ctx.byId.get(t.originId)?.subject) || "Event from the root marker"} />
    </Shell>
  )
}

function RunRow({ d, ctx }: { d: FleetDispatch; ctx: CardCtx }) {
  const s = runStatus(d)
  return (
    <button className="tm-row__main" onClick={() => ctx.onOpenItem(d)}>
      <span className={`tm-pill is-${s.tone}`}>{s.label}</span>
      <span className="tm-row__t">{gist(d)}</span>
      <small>{fmtTime(d.startedAt)}{d.nodeId ? ` · ${nodeLabel(ctx.snap, d.nodeId)}` : ""}</small>
    </button>
  )
}

/** Station: the agent, where it runs, what it is doing now and lately. */
export function StationCard({ id, ctx, sheet, onClose }: { id: string; ctx: CardCtx; sheet?: boolean; onClose: () => void }) {
  const runs = [...ctx.byId.values()].filter((d) => d.agentId === id && !d.system).sort((a, b) => b.startedAt - a.startedAt)
  const nodes = [...new Set(runs.map((d) => d.nodeId).filter((n): n is string => !!n))]
  const now = runs.filter((d) => d.active)
  const recent = runs.filter((d) => !d.active).slice(0, 5)
  const lines = [...new Set(ctx.transit.trains.filter((t) => t.route.includes(id)).map((t) => t.lineId))]
    .map((l) => ctx.transit.lines.find((x) => x.id === l)).filter((l) => !!l)
  const agent = ctx.snap.agents.find((a) => a.id === id)
  return (
    <Shell kick="Station" title={ctx.agentName(id)} sheet={sheet} onClose={onClose}
      badge={now.length ? <span className="tm-badge is-running is-sm">Running</span> : undefined}>
      <div className="tm-panel__who">
        {[agent?.title, id !== ctx.agentName(id) ? id : "", nodes.length ? `on ${nodes.map((n) => nodeLabel(ctx.snap, n)).join(", ")}` : ""].filter(Boolean).join(" · ")}
      </div>
      {lines.length > 0 && (
        <div className="tm-route">
          {lines.map((l) => <span key={l!.id} className="tm-chip is-line" style={{ ["--lc" as string]: l!.color }}>{l!.code} {l!.name}</span>)}
        </div>
      )}
      <div className="tm-panel__sec">Running now</div>
      {now.length ? <div className="tm-rows">{now.slice(0, 5).map((d) => <div key={d.id} className="tm-row"><RunRow d={d} ctx={ctx} /></div>)}</div>
        : <Empty>Nothing running.</Empty>}
      <div className="tm-panel__sec">Recent runs</div>
      {recent.length ? <div className="tm-rows">{recent.map((d) => <div key={d.id} className="tm-row"><RunRow d={d} ctx={ctx} /></div>)}</div>
        : <Empty>No finished runs in this window.</Empty>}
    </Shell>
  )
}

/** Hops that match a selection: one hop, or every hop on a track. */
export function hopsFor(sel: Extract<Sel, { kind: "hop" }>, trains: Train[]): Array<{ hop: Hop; train: Train }> {
  const out = new Map<string, { hop: Hop; train: Train }>()
  for (const t of trains) {
    if (sel.lineId && t.lineId !== sel.lineId) continue
    for (const h of t.hops) {
      const hit = sel.dispatchId !== undefined ? h.dispatchId === sel.dispatchId && h.to === sel.to : h.from === sel.from && h.to === sel.to
      if (hit) out.set(h.dispatchId ?? `${t.id}|${h.to}`, { hop: h, train: t })
    }
  }
  return [...out.values()].sort((a, b) => b.hop.at - a.hop.at)
}

/** Hop: from → to, what was sent, when, and how it ended. */
export function HopCard({ sel, ctx, sheet, onClose }: { sel: Extract<Sel, { kind: "hop" }>; ctx: CardCtx; sheet?: boolean; onClose: () => void }) {
  const found = hopsFor(sel, ctx.transit.trains)
  const from = sel.from ? ctx.agentName(sel.from) : "Channel"
  const back = found[0]?.hop.kind === "return"
  return (
    <Shell kick={back ? "Hop · answer coming back" : "Hop"} title={`${from} → ${ctx.agentName(sel.to)}`} sheet={sheet} onClose={onClose}
      badge={found.length > 1 ? <span className="tm-badge is-sm">{found.length} hand-offs</span> : undefined}>
      {!found.length && <Empty>This hop is not in the current window.</Empty>}
      {found.slice(0, 8).map(({ hop, train }) => {
        const d = hop.dispatchId ? ctx.byId.get(hop.dispatchId) : undefined
        const s = d ? runStatus(d) : null
        return (
          <div key={(hop.dispatchId ?? "") + train.id} className="tm-hop">
            <div className="tm-hop__hd">
              <span className="mono">{fmtTime(hop.at)}</span>
              {s ? <span className={`tm-pill is-${s.tone}`}>{s.label}</span> : <span className="tm-pill is-muted">Known from the root marker</span>}
              <button className="tm-link" onClick={() => ctx.onSelect({ kind: "train", id: train.id })}>{train.tag} ›</button>
            </div>
            {hop.node && <small className="tm-hop__node">{ctx.agentName(hop.to)} on {nodeLabel(ctx.snap, hop.node)} · {fmtRelative(hop.at)}</small>}
            <Message text={d?.inputPreview || d?.subject || ""} />
            {d && <button className="tm-link" onClick={() => ctx.onOpenItem(d)}>Open run details ›</button>}
          </div>
        )
      })}
    </Shell>
  )
}
