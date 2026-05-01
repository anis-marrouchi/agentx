// Fleet snapshot API — one-shot fetch + SSE subscription. The server
// builds the same shape on every tick; the client diffs on its own.

export interface FleetClient { id: string; name: string; color: string; projects: string[] }
export interface FleetAgent { id: string; name: string; tier: "lead" | "worker"; model: string; role: string }
export interface FleetChannel { id: string; label: string; color: string }
export interface FleetInitiator { id: string; name: string; avatar: string }
export interface FleetDispatch {
  id: string
  agentId: string
  clientId: string
  projectId: string
  channelId: string
  initiatorId: string
  subject: string
  intent: string
  startedAt: number
  resolvedAt: number | null
  duration: number
  active: boolean
  outcome: "completed" | "active" | "error"
  tokens: number
}
export interface FleetSnapshot {
  now: number
  windowH: number
  clients: FleetClient[]
  agents: FleetAgent[]
  channels: FleetChannel[]
  initiators: FleetInitiator[]
  dispatches: FleetDispatch[]
}

export async function fetchSnapshot(windowH: number): Promise<FleetSnapshot> {
  const r = await fetch(`/api/admin/activity-graph?hours=${encodeURIComponent(windowH)}`, { credentials: "same-origin" })
  if (!r.ok) throw new Error(`activity-graph fetch ${r.status}`)
  return await r.json() as FleetSnapshot
}

export function subscribeSnapshot(windowH: number, onSnapshot: (s: FleetSnapshot) => void, onError?: () => void): () => void {
  const url = `/api/admin/activity-graph/stream?hours=${encodeURIComponent(windowH)}`
  const es = new EventSource(url, { withCredentials: true })
  es.addEventListener("snapshot", (ev) => {
    try { onSnapshot(JSON.parse((ev as MessageEvent).data) as FleetSnapshot) }
    catch (e) { console.error("[activity-graph] snapshot parse failed", e) }
  })
  es.addEventListener("error", () => { onError?.() })
  return () => { try { es.close() } catch (_) { /* ignore */ } }
}

// Format helpers (ported from prototype/data.js)
export function fmtDur(ms: number | null): string {
  if (ms == null) return "—"
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + "s"
  const m = Math.floor(s / 60)
  if (m < 60) return m + "m"
  const h = Math.floor(m / 60)
  return h + "h " + (m % 60) + "m"
}
export function fmtTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}
export function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return m + "m ago"
  const h = Math.floor(m / 60)
  if (h < 24) return h + "h ago"
  return Math.floor(h / 24) + "d ago"
}
