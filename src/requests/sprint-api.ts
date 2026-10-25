import type { CallerProof } from "./daemon-api"
import type { SprintStore } from "./sprint-store"
import { cancelSprint, laneAction, newSprintId, parseSprint, type LaneAction, type SprintSettings } from "./sprints"

// --- The daemon's /sprints endpoints (#1241) ---
//
// Reachable by agents (the agentx_sprint tool posts here), gated like
// /requests: loopback, or a mesh token.
//   GET  /sprints        active sprints, then the last finished ones
//   GET  /sprints/:id    one sprint: its lanes, items and log
//   POST /sprints        an agent's statement: start (a new sprint, by its
//                        lead), block (a lane's agent or the lead stops a
//                        lane, with a note), retry, skip, hold, release
//                        (the lead moves a lane on) or cancel (the lead
//                        stops the sprint). The call must prove it comes
//                        from a running turn of that agent (CallerProof).
// The owner does the same from `agentx requests sprints`.

export interface SprintsApiDeps {
  store: SprintStore
  settings: SprintSettings
  hasAgent: (agentId: string) => boolean
  runningTurn: (agentId: string, proof: CallerProof) => { channel: string; chatId: string } | null
  /** A sprint was made or a lane moved: run the sprint check soon. */
  onChange?: () => void
  now?: number
}

export interface SprintsReply {
  status: number
  body: unknown
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
const LANE_ACTIONS: readonly LaneAction[] = ["retry", "skip", "hold", "release", "block"]

function view(store: SprintStore, id: string, withEvents: boolean): Record<string, unknown> | null {
  const sprint = store.get(id)
  if (!sprint) return null
  return {
    sprint,
    lanes: store.lanes(id),
    items: store.items(id),
    ...(withEvents ? { events: store.events(id) } : {}),
  }
}

export function handleSprintsApi(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  deps: SprintsApiDeps,
  caller: CallerProof = {},
): SprintsReply {
  const { store } = deps
  const id = path.startsWith("/sprints/") ? decodeURIComponent(path.slice("/sprints/".length)) : ""

  if (method === "GET") {
    if (id) {
      const v = view(store, id, true)
      return v ? { status: 200, body: v } : { status: 404, body: { error: `no sprint "${id}"` } }
    }
    const active = store.listActive()
    const recent = store.list({ limit: 10 }).filter((s) => s.state !== "active")
    return { status: 200, body: { enabled: deps.settings.enabled, items: [...active, ...recent].map((s) => view(store, s.id, false)) } }
  }
  if (method !== "POST" || id) return { status: 405, body: { error: "use GET /sprints, GET /sprints/:id or POST /sprints" } }

  const input = body ?? {}
  const action = str(input.action).toLowerCase()
  if (action !== "start" && action !== "cancel" && !LANE_ACTIONS.includes(action as LaneAction)) {
    return { status: 400, body: { error: `unknown action "${action}": use start, block, retry, skip, hold, release or cancel` } }
  }
  if (!deps.settings.enabled) return { status: 409, body: { error: "Sprints are turned off on this node (requests.sprints.enabled)." } }
  const agentId = str(input.agentId)
  if (!agentId || !deps.hasAgent(agentId)) return { status: 400, body: { error: "agentId must be an agent on this node" } }
  if (!deps.runningTurn(agentId, caller)) {
    return { status: 403, body: { error: `no running turn of "${agentId}" matches this call: use the agentx_sprint tool from inside your run` } }
  }
  const now = deps.now ?? Date.now()

  if (action === "start") {
    const parsed = parseSprint(input, deps.hasAgent)
    if (typeof parsed === "string") return { status: 400, body: { error: parsed } }
    const sprintId = newSprintId()
    store.create({ id: sprintId, createdBy: agentId, ...parsed }, now)
    deps.onChange?.()
    return { status: 200, body: view(store, sprintId, false) }
  }

  const sprintId = str(input.id)
  const sprint = sprintId ? store.get(sprintId) : null
  if (!sprint) return { status: 404, body: { error: sprintId ? `no sprint "${sprintId}"` : "id is required: the sprint's id (spr-…)" } }

  if (action === "cancel") {
    if (sprint.createdBy !== agentId) return { status: 403, body: { error: `sprint ${sprint.id} was started by ${sprint.createdBy}: only it, or the owner, cancels it` } }
    const err = cancelSprint(store, sprint.id, agentId, now)
    if (err) return { status: 409, body: { error: err } }
    return { status: 200, body: view(store, sprint.id, false) }
  }

  const laneName = str(input.lane)
  const lane = laneName ? store.lane(sprint.id, laneName) : null
  if (!lane) return { status: 404, body: { error: laneName ? `sprint ${sprint.id} has no lane "${laneName}"` : "lane is required: the lane's name" } }
  // A lane's agent stops its own lane; moving a lane on is the lead's.
  const allowed = action === "block" ? [sprint.createdBy, lane.agentId] : [sprint.createdBy]
  if (!allowed.includes(agentId)) {
    return { status: 403, body: { error: `only ${allowed.join(" or ")} (or the owner) may ${action} lane ${lane.lane} of ${sprint.id}` } }
  }
  let item: number | undefined
  if (input.item !== undefined && input.item !== null && input.item !== "") {
    item = Number(input.item)
    if (!Number.isInteger(item) || item < 1) return { status: 400, body: { error: "item must be the item's number in its lane (1 is the first)" } }
  }
  const err = laneAction(store, { sprintId: sprint.id, lane: lane.lane, action: action as LaneAction, item, note: str(input.note), by: agentId }, now)
  if (err) return { status: /^no |has no/.test(err) ? 404 : /needs note/.test(err) ? 400 : 409, body: { error: err } }
  deps.onChange?.()
  return { status: 200, body: view(store, sprint.id, false) }
}
