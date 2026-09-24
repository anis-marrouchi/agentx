import { useState, useMemo, useEffect, useCallback } from "react"
import {
  fetchSnapshot, subscribeSnapshot, fetchDispatchDetail, fmtDur, fmtTime,
  type FleetSnapshot, type FleetDispatch, type FleetClient, type FleetAgent,
  type FleetChannel, type FleetInitiator, type FleetDispatchDetail,
} from "./api"
import { MapPerspective } from "./MapPerspective"

// Fleet map, mounted as the Map view of /activity. The host page owns the
// time window (its 6h/24h/3d/7d control drives both views) and announces
// changes with an `ax:activity-hours` event, so there is one window control
// on the page, not two.

export const HOURS_EVENT = "ax:activity-hours"

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

/** Human label for the trigger kind, shown next to the initiator's name so
 *  the drawer makes the origin obvious (GitLab MR / Cron / etc.). Returns
 *  undefined for kinds that add no information. */
function kindLabel(kind: string | undefined): string | undefined {
  switch (kind) {
    case "gitlab":   return "GitLab webhook"
    case "github":   return "GitHub webhook"
    case "cron":     return "Cron job"
    case "workflow": return "Workflow"
    case "a2a":      return "Agent → Agent"
    case "mesh":     return "Mesh"
    case "system":   return "System"
    default:         return undefined
  }
}

interface Lookup {
  getClient: (id: string) => FleetClient | undefined
  getAgent: (id: string) => FleetAgent | undefined
  getChannel: (id: string) => FleetChannel | undefined
  getInitiator: (id: string) => FleetInitiator | undefined
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
    getInitiator: (id) => iBy.get(id) || { id, name: id, avatar: id.slice(0, 2).toUpperCase(), kind: "system" as const },
  }
}

// ─────────────────────────────────────────────────────────────────────
// Filter

interface FilterState {
  activeOnly: boolean
  showSystem: boolean
  search: string
}
function applyFilter(dispatches: FleetDispatch[], filter: FilterState, windowMs: number, now: number): FleetDispatch[] {
  const cutoff = now - windowMs
  return dispatches.filter((d) => {
    if (d.startedAt < cutoff && (!d.resolvedAt || d.resolvedAt < cutoff)) return false
    if (!filter.showSystem && d.system) return false
    if (filter.activeOnly && !d.active) return false
    if (filter.search) {
      const q = filter.search.toLowerCase()
      if (!d.subject.toLowerCase().includes(q) && !d.projectId.toLowerCase().includes(q)) return false
    }
    return true
  })
}

// ─────────────────────────────────────────────────────────────────────
// Subbar

function Subbar(props: {
  filter: FilterState; updateFilter: (patch: Partial<FilterState>) => void
  dispatches: FleetDispatch[]; stale: boolean
}) {
  const { filter, updateFilter, dispatches, stale } = props
  return (
    <div className="subbar">
      <input
        className="search-input"
        placeholder="Search subjects, projects…"
        aria-label="Search subjects and projects"
        value={filter.search}
        onChange={(e) => updateFilter({ search: e.target.value })}
      />
      <button className={"facet " + (filter.activeOnly ? "is-on" : "")} aria-pressed={filter.activeOnly} onClick={() => updateFilter({ activeOnly: !filter.activeOnly })}>
        ● active only
      </button>
      <button className={"facet " + (filter.showSystem ? "is-on" : "")} aria-pressed={filter.showSystem} onClick={() => updateFilter({ showSystem: !filter.showSystem })} title="Show internal infrastructure (classifier sub-calls, background workers)">
        ⚙ show system
      </button>
      <div style={{ flex: 1 }} />
      <span className="live-pulse">{stale ? "reconnecting" : "Live · streaming"}</span>
      <span className="subbar__lbl">{dispatches.length} dispatches</span>
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
          <div className="drawer__row"><span className="k">Agent</span><span className="v">{agent?.name || item.agentId} {agent && <span className="tier" style={{ marginLeft: 6 }}>{agent.tier}</span>}{item.nodeId && <span className="mono" style={{ marginLeft: 8, fontSize: 10, color: "var(--ax-muted)", padding: "1px 5px", border: "1px solid var(--ax-border)", borderRadius: 3 }}>{item.nodeId}</span>}</span></div>
          <div className="drawer__row"><span className="k">Channel</span><span className="v">{channel?.label || item.channelId} <span className="mono" style={{ color: "var(--ax-muted)", marginLeft: 4 }}>· from {initiator?.name || "Schedule"}{kindLabel(initiator?.kind) ? ` (${kindLabel(initiator?.kind)})` : ""}</span></span></div>
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
                <div className="journey-step__time">{kindLabel(initiator?.kind) ? `${kindLabel(initiator?.kind)} · ` : "via "}{channel?.label || item.channelId}</div>
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

export function App({ initialHours }: { initialHours: number }) {
  const [windowH, setWindowH] = useState(initialHours)
  const [filter, setFilter] = useState<FilterState>({ activeOnly: false, showSystem: false, search: "" })
  const updateFilter = useCallback((patch: Partial<FilterState>) => setFilter((f) => ({ ...f, ...patch })), [])
  const [openItem, setOpenItem] = useState<FleetDispatch | null>(null)

  useEffect(() => {
    const on = (e: Event) => {
      const h = Number((e as CustomEvent).detail)
      if (h > 0) setWindowH(h)
    }
    window.addEventListener(HOURS_EVENT, on)
    return () => window.removeEventListener(HOURS_EVENT, on)
  }, [])

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
    <div className="ax-fleet is-map">
      <Subbar filter={filter} updateFilter={updateFilter} dispatches={visible} stale={stale} />
      <div className="content">
        <MapPerspective snap={snap} dispatches={visible} windowH={windowH} onOpenItem={setOpenItem} />
      </div>
      <Drawer item={openItem} lookup={lookup} onClose={() => setOpenItem(null)} />
    </div>
  )
}
