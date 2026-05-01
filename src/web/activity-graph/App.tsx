import { useState, useMemo, useEffect, useRef, useCallback } from "react"
import {
  fetchSnapshot, subscribeSnapshot, fetchDispatchDetail, fmtDur, fmtTime, fmtRelative,
  type FleetSnapshot, type FleetDispatch, type FleetClient, type FleetAgent,
  type FleetChannel, type FleetInitiator, type FleetDispatchDetail,
} from "./api"

// ─────────────────────────────────────────────────────────────────────
// Stream hook — fetches the initial snapshot and subscribes to SSE.

function useFleet(windowH: number): { snap: FleetSnapshot | null; stale: boolean } {
  const [snap, setSnap] = useState<FleetSnapshot | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let cancelled = false
    setSnap(null)
    fetchSnapshot(windowH).then((s) => { if (!cancelled) setSnap(s) }).catch(console.error)
    const unsub = subscribeSnapshot(windowH, (s) => { setSnap(s); setStale(false) }, () => setStale(true))
    return () => { cancelled = true; unsub() }
  }, [windowH])

  return { snap, stale }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

function uniq<T>(arr: T[]): T[] { return Array.from(new Set(arr)) }
function sum<T>(arr: T[], fn?: (x: T) => number): number {
  return arr.reduce((a, x) => a + (fn ? fn(x) : (x as unknown as number)), 0)
}
function statusOf(d: FleetDispatch): "active" | "completed" | "error" {
  if (d.active) return "active"
  if (d.outcome === "error") return "error"
  return "completed"
}

interface Lookup {
  getClient: (id: string) => FleetClient | undefined
  getAgent: (id: string) => FleetAgent | undefined
  getChannel: (id: string) => FleetChannel | undefined
  getInitiator: (id: string) => FleetInitiator | undefined
  colorFor: (clientId: string) => string
}
function makeLookup(snap: FleetSnapshot): Lookup {
  const cBy = new Map(snap.clients.map((c) => [c.id, c]))
  const aBy = new Map(snap.agents.map((a) => [a.id, a]))
  const chBy = new Map(snap.channels.map((c) => [c.id, c]))
  const iBy = new Map(snap.initiators.map((i) => [i.id, i]))
  return {
    getClient: (id) => cBy.get(id),
    getAgent: (id) => aBy.get(id),
    getChannel: (id) => chBy.get(id),
    getInitiator: (id) => iBy.get(id) || { id, name: id, avatar: id.slice(0, 2).toUpperCase() },
    colorFor: (id) => cBy.get(id)?.color || "#6b7280",
  }
}

// ─────────────────────────────────────────────────────────────────────
// Filter

interface FilterState {
  client: string | null
  agent: string | null
  channel: string | null
  initiator: string | null
  activeOnly: boolean
  showSystem: boolean
  search: string
}
function applyFilter(dispatches: FleetDispatch[], filter: FilterState, windowMs: number, now: number): FleetDispatch[] {
  const cutoff = now - windowMs
  return dispatches.filter((d) => {
    if (d.startedAt < cutoff && (!d.resolvedAt || d.resolvedAt < cutoff)) return false
    if (!filter.showSystem && d.system) return false
    if (filter.client && d.clientId !== filter.client) return false
    if (filter.agent && d.agentId !== filter.agent) return false
    if (filter.channel && d.channelId !== filter.channel) return false
    if (filter.initiator && d.initiatorId !== filter.initiator) return false
    if (filter.activeOnly && !d.active) return false
    if (filter.search) {
      const q = filter.search.toLowerCase()
      if (!d.subject.toLowerCase().includes(q) && !d.projectId.toLowerCase().includes(q)) return false
    }
    return true
  })
}

// ─────────────────────────────────────────────────────────────────────
// Tooltip

function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: React.ReactNode } | null>(null)
  const show = (e: React.MouseEvent, content: React.ReactNode) => setTip({ x: e.clientX, y: e.clientY, content })
  const move = (e: React.MouseEvent) => setTip((t) => (t ? { ...t, x: e.clientX, y: e.clientY } : null))
  const hide = () => setTip(null)
  const node = tip ? <div className="tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>{tip.content}</div> : null
  return { show, move, hide, node }
}

// ─────────────────────────────────────────────────────────────────────
// Subbar

const PERSPECTIVES = [
  { id: "fleet", label: "Fleet", desc: "Agent roster" },
  { id: "clients", label: "Clients", desc: "By client / project" },
  { id: "timeline", label: "Timeline", desc: "Gantt over time" },
  { id: "flow", label: "Flow", desc: "Journey lanes" },
] as const
type Perspective = (typeof PERSPECTIVES)[number]["id"]

const WINDOWS = [
  { id: 1, label: "1h" },
  { id: 6, label: "6h" },
  { id: 24, label: "today" },
  { id: 168, label: "week" },
  { id: 720, label: "month" },
]

function Subbar(props: {
  perspective: Perspective; setPerspective: (p: Perspective) => void
  windowH: number; setWindowH: (h: number) => void
  filter: FilterState; updateFilter: (patch: Partial<FilterState>) => void
  dispatches: FleetDispatch[]; lookup: Lookup; stale: boolean
}) {
  const { perspective, setPerspective, windowH, setWindowH, filter, updateFilter, dispatches, lookup, stale } = props
  const activeFacets: { k: keyof FilterState; label: string }[] = []
  if (filter.client) activeFacets.push({ k: "client", label: lookup.getClient(filter.client)?.name || filter.client })
  if (filter.agent) activeFacets.push({ k: "agent", label: filter.agent })
  if (filter.channel) activeFacets.push({ k: "channel", label: lookup.getChannel(filter.channel)?.label || filter.channel })
  if (filter.initiator) activeFacets.push({ k: "initiator", label: lookup.getInitiator(filter.initiator)?.name || filter.initiator })

  return (
    <div className="subbar">
      <div className="persp-switch">
        {PERSPECTIVES.map((p) => (
          <button key={p.id} className={perspective === p.id ? "is-active" : ""} onClick={() => setPerspective(p.id)} title={p.desc}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="subbar__sep" />
      <div className="window-pick">
        {WINDOWS.map((w) => (
          <button key={w.id} className={windowH === w.id ? "is-active" : ""} onClick={() => setWindowH(w.id)}>{w.label}</button>
        ))}
      </div>
      <input
        className="search-input"
        placeholder="Search subjects, projects…"
        value={filter.search}
        onChange={(e) => updateFilter({ search: e.target.value })}
      />
      {activeFacets.map((f) => (
        <button key={f.k} className="facet is-on" onClick={() => updateFilter({ [f.k]: null } as Partial<FilterState>)}>
          {f.k}: {f.label} <span className="x">✕</span>
        </button>
      ))}
      <button className={"facet " + (filter.activeOnly ? "is-on" : "")} onClick={() => updateFilter({ activeOnly: !filter.activeOnly })}>
        ● active only
      </button>
      <button className={"facet " + (filter.showSystem ? "is-on" : "")} onClick={() => updateFilter({ showSystem: !filter.showSystem })} title="Show internal infrastructure (classifier sub-calls, background workers)">
        ⚙ show system
      </button>
      <div style={{ flex: 1 }} />
      <span className="live-pulse">{stale ? "reconnecting" : "Live · streaming"}</span>
      <span className="subbar__lbl">{dispatches.length} dispatches</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// KPI strip

function KpiStrip({ snap, dispatches, windowH }: { snap: FleetSnapshot; dispatches: FleetDispatch[]; windowH: number }) {
  const stats = useMemo(() => {
    const active = dispatches.filter((d) => d.active)
    const total = dispatches.length
    const totalDur = sum(dispatches, (d) => d.duration)
    const errors = dispatches.filter((d) => d.outcome === "error").length
    const clientsTouched = uniq(dispatches.map((d) => d.clientId)).length
    const agentsActive = uniq(active.map((d) => d.agentId)).length
    const fleetSize = snap.agents.length
    const buckets = 24
    const bucketSize = (windowH * 3600 * 1000) / buckets
    const cutoff = snap.now - windowH * 3600 * 1000
    const counts = new Array(buckets).fill(0)
    dispatches.forEach((d) => {
      const idx = Math.floor((d.startedAt - cutoff) / bucketSize)
      if (idx >= 0 && idx < buckets) counts[idx]++
    })
    return { active: active.length, total, totalDur, errors, clientsTouched, agentsActive, fleetSize, counts }
  }, [snap, dispatches, windowH])

  const max = Math.max(1, ...stats.counts)
  return (
    <div className="kpis">
      <div className="kpi kpi--success">
        <div className="kpi__lbl">Active now</div>
        <div className="kpi__val">{stats.active}</div>
        <div className="kpi__sub">{stats.agentsActive} of {stats.fleetSize} agents engaged</div>
      </div>
      <div className="kpi">
        <div className="kpi__lbl">Dispatches in window</div>
        <div className="kpi__val">{stats.total}</div>
        <div className="kpi__spark">
          {stats.counts.map((c, i) => (
            <span key={i} style={{ height: ((c / max) * 100) + "%" }} className={i === stats.counts.length - 1 ? "is-now" : ""} />
          ))}
        </div>
      </div>
      <div className="kpi">
        <div className="kpi__lbl">Total agent-time</div>
        <div className="kpi__val">{fmtDur(stats.totalDur)}</div>
        <div className="kpi__sub">across {stats.total} runs</div>
      </div>
      <div className="kpi kpi--accent">
        <div className="kpi__lbl">Clients touched</div>
        <div className="kpi__val">{stats.clientsTouched}</div>
        <div className="kpi__sub">of {snap.clients.length} on roster</div>
      </div>
      <div className={"kpi " + (stats.errors > 0 ? "kpi--warn" : "")}>
        <div className="kpi__lbl">Errors</div>
        <div className="kpi__val">{stats.errors}</div>
        <div className="kpi__sub">{stats.errors === 0 ? "all clean" : "needs attention"}</div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Fleet perspective

function FleetPerspective(props: {
  snap: FleetSnapshot; dispatches: FleetDispatch[]; lookup: Lookup
  onOpenItem: (d: FleetDispatch) => void
  updateFilter: (patch: Partial<FilterState>) => void
  showIdle: boolean
}) {
  const { snap, dispatches, lookup, onOpenItem, updateFilter, showIdle } = props
  const tip = useTip()
  const agentStats = useMemo(() => {
    return snap.agents.map((a) => {
      const mine = dispatches.filter((d) => d.agentId === a.id)
      const active = mine.filter((d) => d.active)
      const totalDur = sum(mine, (d) => d.duration)
      const errors = mine.filter((d) => d.outcome === "error").length
      const clientBreakdown: Record<string, { count: number; dur: number }> = {}
      mine.forEach((d) => {
        if (!clientBreakdown[d.clientId]) clientBreakdown[d.clientId] = { count: 0, dur: 0 }
        clientBreakdown[d.clientId].count++
        clientBreakdown[d.clientId].dur += d.duration
      })
      return { agent: a, mine, active, totalDur, errors, clientBreakdown }
    })
  }, [snap, dispatches])

  const visible = showIdle ? agentStats : agentStats.filter((s) => s.mine.length > 0)

  return (
    <div className="fleet-grid">
      {visible.length === 0 && <div className="empty">No agents have run in this window.</div>}
      {visible.map(({ agent, mine, active, totalDur, errors, clientBreakdown }) => {
        const isActive = active.length > 0
        const current = active[0]
        const totalForBar = sum(Object.values(clientBreakdown), (x) => x.dur) || 1
        return (
          <div key={agent.id} className={"agent-card" + (isActive ? " is-active" : "") + (mine.length === 0 ? " agent-card--idle" : "")}>
            <div className="agent-card__hd">
              <div className="avatar avatar--lg avatar--agent">{agent.name.slice(0, 2).toUpperCase()}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="agent-card__name" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {agent.name}
                  <span className={"tier tier--" + agent.tier}>{agent.tier}</span>
                </div>
                <div className="agent-card__role">{agent.role || agent.id} · <span className="mono">{agent.model}</span></div>
              </div>
              <div className="agent-card__status">
                {isActive ? <span className="chip chip--active">● live · {active.length}</span>
                  : mine.length === 0 ? <span className="chip chip--done">idle</span>
                  : <span className="chip chip--done">resting</span>}
              </div>
            </div>

            <div className="agent-card__metrics">
              <div className="agent-card__metric"><span className="k">Tasks</span><span className="v">{mine.length}</span></div>
              <div className="agent-card__metric"><span className="k">Time</span><span className="v">{fmtDur(totalDur)}</span></div>
              <div className="agent-card__metric"><span className="k">Active</span><span className={"v " + (active.length > 0 ? "success" : "")}>{active.length}</span></div>
              <div className="agent-card__metric"><span className="k">Errors</span><span className={"v " + (errors > 0 ? "warn" : "")}>{errors}</span></div>
            </div>

            {current && (
              <div className="agent-card__current" onClick={() => onOpenItem(current)}>
                <div className="lbl">Currently working on</div>
                <div className="subj">{current.subject}</div>
                <div className="meta">
                  <span className="dot" style={{ background: lookup.colorFor(current.clientId) }} />
                  <span className="mono">{current.projectId}</span>
                  <span>·</span>
                  <span>started {fmtRelative(current.startedAt)}</span>
                </div>
              </div>
            )}

            {Object.keys(clientBreakdown).length > 0 && (
              <>
                <div className="agent-card__bar" onMouseLeave={tip.hide}>
                  {Object.entries(clientBreakdown).map(([cid, v]) => {
                    const c = lookup.getClient(cid)
                    const pct = (v.dur / totalForBar) * 100
                    return (
                      <i key={cid}
                        style={{ background: c?.color || "#6b7280", width: pct + "%" }}
                        onMouseEnter={(e) => tip.show(e, <><div className="t">{c?.name || cid}</div><div className="r">{v.count} dispatch{v.count === 1 ? "" : "es"} · {fmtDur(v.dur)}</div></>)}
                        onMouseMove={tip.move}
                      />
                    )
                  })}
                </div>
                <div className="agent-card__clients">
                  {Object.entries(clientBreakdown).map(([cid, v]) => {
                    const c = lookup.getClient(cid)
                    return (
                      <span key={cid} className="agent-card__client-pill" onClick={() => updateFilter({ client: cid })}>
                        <span className="dot" style={{ background: c?.color, width: 6, height: 6 }} />
                        {c?.id || cid}
                        <span style={{ opacity: 0.7 }}>· {fmtDur(v.dur)}</span>
                      </span>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )
      })}
      {tip.node}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Clients perspective

function ClientsPerspective(props: {
  snap: FleetSnapshot; dispatches: FleetDispatch[]; lookup: Lookup
  updateFilter: (patch: Partial<FilterState>) => void
}) {
  const { snap, dispatches, lookup, updateFilter } = props
  const [openClient, setOpenClient] = useState<string | null>(null)
  const tip = useTip()

  const clientData = useMemo(() => {
    const clientTotal: Record<string, { client: FleetClient; items: FleetDispatch[]; dur: number; active: number; agents: Set<string>; projects: Record<string, { items: FleetDispatch[]; dur: number; active: number; agents: Set<string> }> }> = {}
    snap.clients.forEach((c) => {
      clientTotal[c.id] = { client: c, items: [], dur: 0, active: 0, agents: new Set(), projects: {} }
    })
    dispatches.forEach((d) => {
      const t = clientTotal[d.clientId]
      if (!t) return
      t.items.push(d)
      t.dur += d.duration
      if (d.active) t.active++
      t.agents.add(d.agentId)
      if (!t.projects[d.projectId]) t.projects[d.projectId] = { items: [], dur: 0, active: 0, agents: new Set() }
      const p = t.projects[d.projectId]
      p.items.push(d)
      p.dur += d.duration
      if (d.active) p.active++
      p.agents.add(d.agentId)
    })
    return Object.values(clientTotal).filter((t) => t.items.length > 0).sort((a, b) => b.dur - a.dur)
  }, [snap, dispatches])

  const maxDur = Math.max(1, ...clientData.map((c) => c.dur))

  return (
    <div className="clients-list">
      {clientData.length === 0 && <div className="empty">No client activity in this window.</div>}
      {clientData.map(({ client, items, dur, active, agents, projects }) => {
        const isOpen = openClient === client.id
        const byAgent: Record<string, number> = {}
        items.forEach((d) => { byAgent[d.agentId] = (byAgent[d.agentId] || 0) + d.duration })
        const sortedAgents = Object.entries(byAgent).sort((a, b) => b[1] - a[1])
        const barTotal = sum(sortedAgents, (e) => e[1]) || 1
        const widthPct = (dur / maxDur) * 100
        return (
          <div key={client.id} className={"client-row " + (isOpen ? "is-open" : "")}>
            <div className="client-row__hd" onClick={() => setOpenClient(isOpen ? null : client.id)}>
              <div className="client-row__name">
                <span className="dot" style={{ background: client.color, width: 12, height: 12 }} />
                {client.name}
                <span className="mono" style={{ fontSize: 10, color: "var(--ax-muted)" }}>{client.id}</span>
              </div>
              <div className="client-row__bar-wrap" style={{ width: widthPct + "%", minWidth: 80 }} onMouseLeave={tip.hide}>
                {sortedAgents.map(([aid, d], idx) => (
                  <div key={aid}
                    className="client-row__bar-seg"
                    style={{ width: ((d / barTotal) * 100) + "%", background: `color-mix(in oklch, ${client.color} ${40 + (idx * 11) % 50}%, var(--ax-surface-2))` }}
                    onMouseEnter={(e) => tip.show(e, <><div className="t">{aid}</div><div className="r">{fmtDur(d)} on {client.name}</div></>)}
                    onMouseMove={tip.move}
                    onClick={(e) => { e.stopPropagation(); updateFilter({ agent: aid, client: client.id }) }}
                  />
                ))}
              </div>
              <div className="client-row__metric">{items.length}<span className="sub">tasks</span></div>
              <div className="client-row__metric">{fmtDur(dur)}<span className="sub">agent-time</span></div>
              <div className="client-row__metric" style={{ color: active > 0 ? "var(--ax-success)" : undefined }}>{active}<span className="sub">active</span></div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                <span className="client-row__metric" style={{ fontSize: 12 }}>{agents.size}<span className="sub">agents</span></span>
                <span className="client-row__caret">▶</span>
              </div>
            </div>
            {isOpen && (
              <div className="client-row__body">
                {Object.entries(projects).sort((a, b) => b[1].dur - a[1].dur).map(([pid, p]) => (
                  <div key={pid} className="project-row">
                    <span style={{ color: "var(--ax-muted)", fontSize: 10 }}>↳</span>
                    <div className="project-row__path">
                      <b>{pid.split("/")[1] || pid}</b>
                      <span style={{ color: "var(--ax-muted)" }}> · {p.items.length} task{p.items.length === 1 ? "" : "s"}</span>
                    </div>
                    <div className="project-row__agents">
                      {Array.from(p.agents).slice(0, 6).map((aid) => (
                        <span key={aid} className="avatar avatar--agent" title={aid}>{aid.slice(0, 2).toUpperCase()}</span>
                      ))}
                    </div>
                    <div style={{ fontSize: 12, fontVariantNumeric: "tabular-nums" }}>{fmtDur(p.dur)}</div>
                    <div style={{ fontSize: 12, color: p.active > 0 ? "var(--ax-success)" : "var(--ax-muted)" }}>{p.active > 0 ? p.active + " active" : "—"}</div>
                    <button className="btn-ghost" onClick={() => updateFilter({ client: client.id })}>Filter</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      {tip.node}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Timeline (Gantt) perspective

function TimelinePerspective(props: {
  snap: FleetSnapshot; dispatches: FleetDispatch[]; lookup: Lookup
  windowH: number; groupBy: "agent" | "client" | "project" | "channel"
  onOpenItem: (d: FleetDispatch) => void
}) {
  const { snap, dispatches, lookup, windowH, groupBy, onOpenItem } = props
  const tip = useTip()
  const trackRef = useRef<HTMLDivElement>(null)
  const [trackWidth, setTrackWidth] = useState(1000)

  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTrackWidth(el.clientWidth))
    ro.observe(el)
    setTrackWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const startMs = snap.now - windowH * 3600 * 1000
  const totalMs = snap.now - startMs
  const xFor = useCallback((ts: number) => Math.max(0, Math.min(trackWidth, ((ts - startMs) / totalMs) * trackWidth)), [trackWidth, startMs, totalMs])

  type Lane = { id: string; label: string; sub: string; color: string; items: FleetDispatch[]; type: string }
  const lanes = useMemo<Lane[]>(() => {
    const map = new Map<string, Lane>()
    if (groupBy === "agent") {
      snap.agents.forEach((a) => map.set(a.id, { id: a.id, label: a.name, sub: a.role || a.tier, color: "#3fb950", items: [], type: "agent" }))
    } else if (groupBy === "client") {
      snap.clients.forEach((c) => map.set(c.id, { id: c.id, label: c.name, sub: c.id, color: c.color, items: [], type: "client" }))
    } else if (groupBy === "channel") {
      snap.channels.forEach((c) => map.set(c.id, { id: c.id, label: c.label, sub: "", color: c.color, items: [], type: "channel" }))
    }
    dispatches.forEach((d) => {
      let key: string
      if (groupBy === "agent") key = d.agentId
      else if (groupBy === "client") key = d.clientId
      else if (groupBy === "channel") key = d.channelId
      else key = d.projectId
      if (!map.has(key) && groupBy === "project") {
        const c = lookup.getClient(d.clientId)
        map.set(key, { id: key, label: key.split("/")[1] || key, sub: c?.name || "", color: c?.color || "#6b7280", items: [], type: "project" })
      }
      const lane = map.get(key)
      if (lane) lane.items.push(d)
    })
    return Array.from(map.values())
      .filter((l) => l.items.length > 0 || groupBy === "agent")
      .sort((a, b) => {
        const d = b.items.length - a.items.length
        return d !== 0 ? d : a.label.localeCompare(b.label)
      })
  }, [snap, dispatches, groupBy, lookup])

  const ticks = useMemo(() => {
    let step: number
    if (windowH <= 1) step = 10 / 60
    else if (windowH <= 6) step = 1
    else if (windowH <= 24) step = 4
    else if (windowH <= 168) step = 24
    else step = 24 * 7
    const out: { ts: number; label: string }[] = []
    let t = snap.now
    while (t >= startMs) {
      out.push({
        ts: t,
        label: step >= 24
          ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })
          : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      })
      t -= step * 3600 * 1000
    }
    return out
  }, [snap.now, windowH, startMs])

  return (
    <div className="timeline">
      <div className="timeline__head">
        <div className="timeline__lane-hd">{groupBy.toUpperCase()}</div>
        <div className="timeline__time-axis" ref={trackRef}>
          {ticks.map((t) => (
            <div key={t.ts} className="timeline__tick" style={{ left: xFor(t.ts) }}>{t.label}</div>
          ))}
        </div>
      </div>
      {lanes.map((lane) => (
        <div key={lane.id} className="timeline__lane">
          <div className="timeline__lane-name">
            <span className="dot" style={{ background: lane.color, width: 8, height: 8 }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{lane.label}</div>
              {lane.sub && <div style={{ fontSize: 10, color: "var(--ax-muted)", overflow: "hidden", textOverflow: "ellipsis" }}>{lane.sub}</div>}
            </div>
            <span style={{ fontSize: 10, fontFamily: "var(--ax-mono)", color: "var(--ax-muted)" }}>{lane.items.length}</span>
          </div>
          <div className="timeline__lane-track" style={{ position: "relative" }} onMouseLeave={tip.hide}>
            {lane.items.map((d) => {
              const x = xFor(d.startedAt)
              const endTs = d.resolvedAt ?? snap.now
              const width = Math.max(4, xFor(endTs) - x)
              const c = lookup.getClient(d.clientId)
              const stackIdx = lane.items.filter((x2) => x2.startedAt < d.startedAt && (x2.resolvedAt ?? snap.now) > d.startedAt).length
              return (
                <div key={d.id}
                  className={"timeline__bar" + (d.active ? " is-active" : "") + (d.outcome === "error" ? " is-error" : "")}
                  style={{
                    left: x, width,
                    background: `color-mix(in oklch, ${c?.color || "#6b7280"} 75%, #000)`,
                    top: 6 + stackIdx * 30,
                  }}
                  onClick={() => onOpenItem(d)}
                  onMouseEnter={(e) => tip.show(e, (
                    <>
                      <div className="t">{d.subject}</div>
                      <div className="r"><span className="mono">{d.projectId}</span> · {d.agentId}</div>
                      <div className="r">started {fmtTime(d.startedAt)} · {fmtDur(d.duration)} {d.active ? "(running)" : ""}</div>
                      {d.outcome === "error" && <div className="r" style={{ color: "var(--ax-danger)" }}>errored</div>}
                    </>
                  ))}
                  onMouseMove={tip.move}
                >
                  <span className="label">{d.subject}</span>
                  <span className="meta">{fmtDur(d.duration)}</span>
                </div>
              )
            })}
            <div className="timeline__now" style={{ left: xFor(snap.now) }} />
          </div>
        </div>
      ))}
      {tip.node}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Flow perspective

function FlowPerspective(props: {
  snap: FleetSnapshot; dispatches: FleetDispatch[]; lookup: Lookup
  onOpenItem: (d: FleetDispatch) => void
  updateFilter: (patch: Partial<FilterState>) => void
}) {
  const { snap, dispatches, lookup, onOpenItem, updateFilter } = props
  const [hover, setHover] = useState<{ type: string; id: string } | null>(null)

  const cols = useMemo(() => {
    const initiators = new Map<string, number>()
    const channels = new Map<string, number>()
    const clients = new Map<string, number>()
    const agents = new Map<string, number>()
    const outcomes = new Map<string, number>()
    dispatches.forEach((d) => {
      const initId = d.initiatorId || "__system"
      initiators.set(initId, (initiators.get(initId) || 0) + 1)
      channels.set(d.channelId, (channels.get(d.channelId) || 0) + 1)
      clients.set(d.clientId, (clients.get(d.clientId) || 0) + 1)
      agents.set(d.agentId, (agents.get(d.agentId) || 0) + 1)
      const out = statusOf(d)
      outcomes.set(out, (outcomes.get(out) || 0) + 1)
    })
    return {
      initiators: Array.from(initiators.entries()).sort((a, b) => b[1] - a[1]),
      channels: Array.from(channels.entries()).sort((a, b) => b[1] - a[1]),
      clients: Array.from(clients.entries()).sort((a, b) => b[1] - a[1]),
      agents: Array.from(agents.entries()).sort((a, b) => b[1] - a[1]),
      outcomes: Array.from(outcomes.entries()).sort((a, b) => b[1] - a[1]),
    }
  }, [dispatches])

  const matches = useCallback((d: FleetDispatch) => {
    if (!hover) return true
    const { type, id } = hover
    if (type === "initiator") return (d.initiatorId || "__system") === id
    if (type === "channel") return d.channelId === id
    if (type === "client") return d.clientId === id
    if (type === "agent") return d.agentId === id
    if (type === "outcome") return statusOf(d) === id
    return true
  }, [hover])

  const matchingDispatches = dispatches.filter(matches)

  return (
    <div style={{ padding: "16px 18px" }}>
      <div style={{ marginBottom: 12, color: "var(--ax-muted)", fontSize: 12 }}>
        Hover any node to highlight the journeys flowing through it. Click to filter.
      </div>
      <div className="flow">
        <FlowCol
          title="Initiator"
          items={cols.initiators.map(([id, n]) => {
            const i = lookup.getInitiator(id)
            return { id, label: i?.name || id, avatar: i?.avatar, count: n, type: "initiator" }
          })}
          hover={hover} setHover={setHover}
          onClick={(it) => updateFilter({ initiator: it.id })}
        />
        <FlowCol
          title="Channel"
          items={cols.channels.map(([id, n]) => ({ id, label: lookup.getChannel(id)?.label || id, color: lookup.getChannel(id)?.color, count: n, type: "channel" }))}
          hover={hover} setHover={setHover}
          onClick={(it) => updateFilter({ channel: it.id })}
        />
        <FlowCol
          title="Client"
          items={cols.clients.map(([id, n]) => ({ id, label: lookup.getClient(id)?.name || id, color: lookup.colorFor(id), count: n, type: "client" }))}
          hover={hover} setHover={setHover}
          onClick={(it) => updateFilter({ client: it.id })}
        />
        <FlowCol
          title="Agent"
          items={cols.agents.map(([id, n]) => ({ id, label: id, avatar: id.slice(0, 2).toUpperCase(), count: n, type: "agent" }))}
          hover={hover} setHover={setHover}
          onClick={(it) => updateFilter({ agent: it.id })}
        />
        <FlowCol
          title="Outcome"
          items={cols.outcomes.map(([id, n]) => ({
            id, label: id, count: n, type: "outcome",
            color: id === "active" ? "var(--ax-success)" : id === "error" ? "var(--ax-danger)" : "var(--ax-muted)",
          }))}
          hover={hover} setHover={setHover}
          onClick={() => undefined}
        />
      </div>
      <div style={{ marginTop: 24 }}>
        <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ax-muted)", fontWeight: 600, marginBottom: 8 }}>
          {hover ? `${matchingDispatches.length} flowing through ${hover.id}` : `All ${matchingDispatches.length} journeys`}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 280, overflow: "auto" }}>
          {matchingDispatches.map((d) => (
            <FlowJourneyRow key={d.id} d={d} lookup={lookup} onClick={() => onOpenItem(d)} />
          ))}
        </div>
      </div>
    </div>
  )
}

interface FlowItem { id: string; label: string; count: number; type: string; avatar?: string; color?: string }

function FlowCol(props: {
  title: string; items: FlowItem[]
  hover: { type: string; id: string } | null
  setHover: (h: { type: string; id: string } | null) => void
  onClick: (it: FlowItem) => void
}) {
  const { title, items, hover, setHover, onClick } = props
  return (
    <div className="flow__col">
      <div className="flow__col-hd">{title}</div>
      {items.map((it) => {
        const isOn = !!(hover && hover.type === it.type && hover.id === it.id)
        return (
          <div key={it.id}
            className={"flow__node" + (isOn ? " is-on" : "")}
            onMouseEnter={() => setHover({ type: it.type, id: it.id })}
            onMouseLeave={() => setHover(null)}
            onClick={() => onClick(it)}
          >
            {it.avatar ? <span className="avatar">{it.avatar}</span>
              : it.color ? <span className="dot" style={{ background: it.color }} />
              : null}
            <span className="nm">{it.label}</span>
            <span className="ct">{it.count}</span>
          </div>
        )
      })}
    </div>
  )
}

function FlowJourneyRow({ d, lookup, onClick }: { d: FleetDispatch; lookup: Lookup; onClick: () => void }) {
  const c = lookup.getClient(d.clientId)
  const init = lookup.getInitiator(d.initiatorId)
  const chan = lookup.getChannel(d.channelId)
  return (
    <div onClick={onClick} style={{
      display: "grid",
      gridTemplateColumns: "90px 90px 140px 90px 1fr 80px 70px",
      gap: 12, alignItems: "center",
      padding: "6px 10px", fontSize: 11,
      background: "var(--ax-bg-elev)", border: "1px solid var(--ax-border)",
      borderRadius: 6, cursor: "pointer",
    }}>
      <span style={{ display: "flex", alignItems: "center", gap: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <span className="avatar" style={{ width: 16, height: 16, fontSize: 8 }}>{init?.avatar}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{init?.name}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span className="dot" style={{ background: chan?.color, width: 6, height: 6 }} />
        {chan?.label}
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>
        <span className="dot" style={{ background: c?.color, width: 6, height: 6 }} />
        <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", fontSize: 10 }}>{d.projectId}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span className="avatar avatar--agent" style={{ width: 16, height: 16, fontSize: 8 }}>{d.agentId.slice(0, 2).toUpperCase()}</span>
        {d.agentId}
      </span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ax-text-2)" }}>{d.subject}</span>
      <span className="mono" style={{ color: "var(--ax-muted)", fontSize: 10 }}>{fmtDur(d.duration)}</span>
      <span>
        {d.active ? <span className="chip chip--active">live</span>
          : d.outcome === "error" ? <span className="chip chip--error">err</span>
          : <span className="chip chip--done">done</span>}
      </span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Detail drawer

function Drawer({ item, lookup, onClose }: { item: FleetDispatch | null; lookup: Lookup; onClose: () => void }) {
  const [detail, setDetail] = useState<FleetDispatchDetail | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!item) { setDetail(null); return }
    setLoading(true)
    let cancelled = false
    fetchDispatchDetail(item.id)
      .then((d) => { if (!cancelled) { setDetail(d); setLoading(false) } })
      .catch((e) => { if (!cancelled) { console.error(e); setLoading(false) } })
    return () => { cancelled = true }
  }, [item?.id])

  if (!item) return null
  const client = lookup.getClient(item.clientId)
  const agent = lookup.getAgent(item.agentId)
  const channel = lookup.getChannel(item.channelId)
  const initiator = lookup.getInitiator(item.initiatorId)

  // Prefer the detail's longer text; fall back to the inline preview.
  const inputText = detail?.input || item.inputPreview || ""
  const responseText = detail?.response || ""

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="drawer__hd">
          <div>
            <div className="drawer__title">{item.subject}</div>
            <div className="drawer__sub">{item.id} · {item.intent}</div>
          </div>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="drawer__body">
          <div className="drawer__row"><span className="k">Status</span><span className="v">
            {item.active ? <span className="chip chip--active">● running</span>
              : item.outcome === "error" ? <span className="chip chip--error">errored</span>
              : <span className="chip chip--done">completed</span>}
          </span></div>
          <div className="drawer__row"><span className="k">Client</span><span className="v"><span className="dot" style={{ background: client?.color, marginRight: 6 }} />{client?.name || item.clientId}</span></div>
          <div className="drawer__row"><span className="k">Project</span><span className="v mono">{item.projectId}</span></div>
          {detail?.attribution && (
            <div className="drawer__row"><span className="k">Attributed via</span><span className="v" style={{ fontSize: 11, color: "var(--ax-muted)" }}>{detail.attribution.via}</span></div>
          )}
          <div className="drawer__row"><span className="k">Agent</span><span className="v">{agent?.name || item.agentId} {agent && <span className="tier" style={{ marginLeft: 6 }}>{agent.tier}</span>}</span></div>
          <div className="drawer__row"><span className="k">Channel</span><span className="v">{channel?.label || item.channelId} <span className="mono" style={{ color: "var(--ax-muted)", marginLeft: 4 }}>· from {initiator?.name || "Schedule"}</span></span></div>
          <div className="drawer__row"><span className="k">Started</span><span className="v">{new Date(item.startedAt).toLocaleString()}</span></div>
          <div className="drawer__row"><span className="k">Duration</span><span className="v">{fmtDur(item.duration)}{item.active ? " (running)" : ""}</span></div>

          {/* Conversation panes — what was sent, what came back */}
          <div className="conv">
            <div className="conv__pane">
              <div className="conv__hd">
                <span className="dot" style={{ background: channel?.color }} />
                <span className="conv__role">Inbound · {initiator?.name || channel?.label}</span>
              </div>
              <pre className="conv__body">{inputText || (loading ? "Loading…" : "(no inbound text)")}</pre>
            </div>
            <div className="conv__pane">
              <div className="conv__hd">
                <span className="avatar avatar--agent" style={{ width: 18, height: 18, fontSize: 8 }}>{(agent?.name || item.agentId).slice(0, 2).toUpperCase()}</span>
                <span className="conv__role">Outbound · {agent?.name || item.agentId}</span>
                {item.active && <span className="chip chip--active" style={{ marginLeft: "auto" }}>● in progress</span>}
              </div>
              <pre className="conv__body">{
                responseText
                  ? responseText
                  : item.active
                    ? "(still running — response will appear here when complete)"
                    : loading
                      ? "Loading…"
                      : "(response not captured)"
              }</pre>
              {detail?.transcriptLen && detail.transcriptLen > 1 && (
                <div className="conv__meta">Full transcript: {detail.transcriptLen} turns (in <span className="mono">.agentx/task-history/</span>)</div>
              )}
            </div>
          </div>

          <div className="drawer__journey">
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--ax-muted)", fontWeight: 600, marginBottom: 12 }}>Task journey</div>
            <div className="journey-step">
              <div className="journey-step__dot" />
              <div>
                <div className="journey-step__label">Started by</div>
                <div className="journey-step__val">{initiator?.name || "Schedule"}</div>
                <div className="journey-step__time">via {channel?.label || item.channelId}</div>
              </div>
            </div>
            <div className="journey-step">
              <div className="journey-step__dot" />
              <div>
                <div className="journey-step__label">Routed to</div>
                <div className="journey-step__val">{agent?.name || item.agentId} {agent?.role && <span style={{ color: "var(--ax-muted)", fontSize: 11 }}>({agent.role})</span>}</div>
                <div className="journey-step__time">{fmtTime(item.startedAt)}</div>
              </div>
            </div>
            <div className="journey-step">
              <div className={"journey-step__dot" + (item.active ? " is-active" : "")} />
              <div>
                <div className="journey-step__label">{item.active ? "In progress" : "Resolved"}</div>
                <div className="journey-step__val">
                  {item.active ? `Running for ${fmtDur(item.duration)}` :
                    item.outcome === "error" ? "Failed" : `Completed in ${fmtDur(item.duration)}`}
                </div>
                {item.resolvedAt && <div className="journey-step__time">{fmtTime(item.resolvedAt)}</div>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Main app

export function App() {
  const [perspective, setPerspective] = useState<Perspective>("fleet")
  const [windowH, setWindowH] = useState(6)
  const [filter, setFilter] = useState<FilterState>({
    client: null, agent: null, channel: null, initiator: null,
    activeOnly: false, showSystem: false, search: "",
  })
  const updateFilter = useCallback((patch: Partial<FilterState>) => setFilter((f) => ({ ...f, ...patch })), [])
  const [openItem, setOpenItem] = useState<FleetDispatch | null>(null)

  const { snap, stale } = useFleet(windowH)
  const lookup = useMemo(() => snap ? makeLookup(snap) : null, [snap])

  const visible = useMemo(() => {
    if (!snap) return [] as FleetDispatch[]
    return applyFilter(snap.dispatches, filter, windowH * 3600 * 1000, snap.now)
  }, [snap, filter, windowH])

  if (!snap || !lookup) {
    return <div className="ax-fleet"><div className="empty">Loading fleet snapshot…</div></div>
  }

  return (
    <div className="ax-fleet">
      <Subbar
        perspective={perspective} setPerspective={setPerspective}
        windowH={windowH} setWindowH={setWindowH}
        filter={filter} updateFilter={updateFilter}
        dispatches={visible} lookup={lookup} stale={stale}
      />
      <KpiStrip snap={snap} dispatches={visible} windowH={windowH} />
      <div className="content">
        {perspective === "fleet" && <FleetPerspective snap={snap} dispatches={visible} lookup={lookup} onOpenItem={setOpenItem} updateFilter={updateFilter} showIdle={true} />}
        {perspective === "clients" && <ClientsPerspective snap={snap} dispatches={visible} lookup={lookup} updateFilter={updateFilter} />}
        {perspective === "timeline" && <TimelinePerspective snap={snap} dispatches={visible} lookup={lookup} windowH={windowH} groupBy="agent" onOpenItem={setOpenItem} />}
        {perspective === "flow" && <FlowPerspective snap={snap} dispatches={visible} lookup={lookup} onOpenItem={setOpenItem} updateFilter={updateFilter} />}
      </div>
      <Drawer item={openItem} lookup={lookup} onClose={() => setOpenItem(null)} />
    </div>
  )
}
