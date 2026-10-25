import type Database from "better-sqlite3"

// --- Sprint lanes: queues of work the daemon hands out (#1241) ---
//
// A sprint is a set of lanes run side by side. Each lane has one agent and
// an ordered list of items (issues, usually). The daemon gives the lane's
// agent one item at a time; when that turn ends, it gives the next one
// (sprints.ts). The queue lives here, not in a model's context, so a lead
// session that ends does not stop the lanes.
//
// Stored in .agentx/db.sqlite. A finished sprint is kept for the record.

export type SprintState = "active" | "done" | "cancelled"
export type LaneState = "active" | "blocked" | "done"
export type ItemState = "pending" | "running" | "done" | "failed" | "held" | "skipped"

/** Items the lane is finished with. */
export const SETTLED_ITEM_STATES: readonly ItemState[] = ["done", "skipped"]

export interface SprintRecord {
  id: string
  title: string
  /** The agent that started the sprint: the lead. */
  createdBy: string
  /** Where the plan lives (an issue or comment link), when given. */
  ref: string | null
  /** This sprint's idle time before the owner is told; null: the setting. */
  idleMinutes: number | null
  state: SprintState
  createdAt: number
  finishedAt: number | null
  /** When the owner was told the sprint finished. Told once. */
  notifiedAt: number | null
}

export interface LaneRecord {
  sprintId: string
  /** The lane's name in the plan: "A", "B", "review"… */
  lane: string
  agentId: string
  state: LaneState
  /** Why it is blocked. */
  note: string | null
  /** Last thing that happened on the lane: an item handed out or ended. */
  updatedAt: number
  /** When the owner was told the lane is idle or blocked; cleared when it moves. */
  notifiedAt: number | null
}

export interface ItemRecord {
  sprintId: string
  lane: string
  /** 1-based position: items run in this order. */
  idx: number
  /** What it is: "#1159", or a link. */
  ref: string
  title: string | null
  /** What the agent is asked to do with it, beyond the default. */
  brief: string | null
  state: ItemState
  /** Why it is held, failed or skipped. */
  note: string | null
  dispatchedAt: number | null
  /** The dispatch the running item belongs to. A turn's end settles the
   *  item only when it carries this token: a retried item's old turn
   *  ending does not settle the new one. */
  dispatchId: string | null
  finishedAt: number | null
}

export interface SprintEvent {
  sprintId: string
  lane: string | null
  idx: number | null
  at: number
  kind: string
  detail: string
}

export interface NewItem {
  ref: string
  title?: string | null
  brief?: string | null
  /** Held items are skipped with a note until released. */
  held?: string | null
}

export interface NewLane {
  lane: string
  agentId: string
  items: NewItem[]
}

const DETAIL_MAX = 1000

export function ensureSprintTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sprints (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_by TEXT NOT NULL,
      ref TEXT,
      idle_minutes REAL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      notified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sprints_state ON sprints(state);
    CREATE TABLE IF NOT EXISTS sprint_lanes (
      sprint_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      state TEXT NOT NULL,
      note TEXT,
      updated_at INTEGER NOT NULL,
      notified_at INTEGER,
      PRIMARY KEY (sprint_id, lane),
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sprint_items (
      sprint_id TEXT NOT NULL,
      lane TEXT NOT NULL,
      idx INTEGER NOT NULL,
      ref TEXT NOT NULL,
      title TEXT,
      brief TEXT,
      state TEXT NOT NULL,
      note TEXT,
      dispatched_at INTEGER,
      dispatch_id TEXT,
      finished_at INTEGER,
      PRIMARY KEY (sprint_id, lane, idx),
      FOREIGN KEY (sprint_id, lane) REFERENCES sprint_lanes(sprint_id, lane) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sprint_events (
      sprint_id TEXT NOT NULL,
      lane TEXT,
      idx INTEGER,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      FOREIGN KEY (sprint_id) REFERENCES sprints(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_events ON sprint_events(sprint_id, at);
  `)
  // A table made before the dispatch token existed.
  const cols = db.prepare("PRAGMA table_info(sprint_items)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === "dispatch_id")) db.exec("ALTER TABLE sprint_items ADD COLUMN dispatch_id TEXT")
}

function toSprint(r: any): SprintRecord {
  return {
    id: r.id, title: r.title, createdBy: r.created_by, ref: r.ref ?? null, idleMinutes: r.idle_minutes ?? null,
    state: r.state, createdAt: r.created_at, finishedAt: r.finished_at ?? null, notifiedAt: r.notified_at ?? null,
  }
}

function toLane(r: any): LaneRecord {
  return {
    sprintId: r.sprint_id, lane: r.lane, agentId: r.agent_id, state: r.state, note: r.note ?? null,
    updatedAt: r.updated_at, notifiedAt: r.notified_at ?? null,
  }
}

function toItem(r: any): ItemRecord {
  return {
    sprintId: r.sprint_id, lane: r.lane, idx: r.idx, ref: r.ref, title: r.title ?? null, brief: r.brief ?? null,
    state: r.state, note: r.note ?? null, dispatchedAt: r.dispatched_at ?? null, dispatchId: r.dispatch_id ?? null,
    finishedAt: r.finished_at ?? null,
  }
}

const LANE_COLUMNS: Record<string, string> = { state: "state", note: "note", updatedAt: "updated_at", notifiedAt: "notified_at" }
const ITEM_COLUMNS: Record<string, string> = {
  state: "state", note: "note", dispatchedAt: "dispatched_at", dispatchId: "dispatch_id", finishedAt: "finished_at",
}

export type LanePatch = Partial<Pick<LaneRecord, "state" | "note" | "updatedAt" | "notifiedAt">>
export type ItemPatch = Partial<Pick<ItemRecord, "state" | "note" | "dispatchedAt" | "dispatchId" | "finishedAt">>

function patchSql(patch: Record<string, unknown>, columns: Record<string, string>): { sets: string[]; values: unknown[] } {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    const col = columns[key]
    if (!col || value === undefined) continue
    sets.push(`${col} = ?`)
    values.push(value)
  }
  return { sets, values }
}

export class SprintStore {
  constructor(private db: Database.Database) {
    ensureSprintTables(db)
  }

  create(input: { id: string; title: string; createdBy: string; ref?: string | null; idleMinutes?: number | null; lanes: NewLane[] }, now: number): void {
    const insertSprint = this.db.prepare(
      "INSERT INTO sprints (id, title, created_by, ref, idle_minutes, state, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    )
    const insertLane = this.db.prepare(
      "INSERT INTO sprint_lanes (sprint_id, lane, agent_id, state, updated_at) VALUES (?, ?, ?, 'active', ?)",
    )
    const insertItem = this.db.prepare(
      "INSERT INTO sprint_items (sprint_id, lane, idx, ref, title, brief, state, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    this.db.transaction(() => {
      insertSprint.run(input.id, input.title, input.createdBy, input.ref ?? null, input.idleMinutes ?? null, now)
      for (const l of input.lanes) {
        insertLane.run(input.id, l.lane, l.agentId, now)
        l.items.forEach((it, i) => {
          insertItem.run(input.id, l.lane, i + 1, it.ref, it.title ?? null, it.brief ?? null, it.held ? "held" : "pending", it.held || null)
        })
      }
      const items = input.lanes.reduce((n, l) => n + l.items.length, 0)
      this.event(input.id, null, null, "created", `${input.lanes.length} lane${input.lanes.length === 1 ? "" : "s"}, ${items} item${items === 1 ? "" : "s"}, by ${input.createdBy}`, now)
    })()
  }

  get(id: string): SprintRecord | null {
    const row = this.db.prepare("SELECT * FROM sprints WHERE id = ?").get(id)
    return row ? toSprint(row) : null
  }

  /** Newest first. */
  list(opts: { state?: SprintState; limit?: number } = {}): SprintRecord[] {
    const limit = opts.limit ?? 50
    const rows = opts.state
      ? this.db.prepare("SELECT * FROM sprints WHERE state = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(opts.state, limit)
      : this.db.prepare("SELECT * FROM sprints ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit)
    return rows.map(toSprint)
  }

  /** Sprints the daemon still follows, oldest first. */
  listActive(): SprintRecord[] {
    return this.db.prepare("SELECT * FROM sprints WHERE state = 'active' ORDER BY created_at, rowid").all().map(toSprint)
  }

  lanes(sprintId: string): LaneRecord[] {
    return this.db.prepare("SELECT * FROM sprint_lanes WHERE sprint_id = ? ORDER BY rowid").all(sprintId).map(toLane)
  }

  lane(sprintId: string, lane: string): LaneRecord | null {
    const row = this.db.prepare("SELECT * FROM sprint_lanes WHERE sprint_id = ? AND lane = ?").get(sprintId, lane)
    return row ? toLane(row) : null
  }

  items(sprintId: string, lane?: string): ItemRecord[] {
    const rows = lane === undefined
      ? this.db.prepare("SELECT * FROM sprint_items WHERE sprint_id = ? ORDER BY lane, idx").all(sprintId)
      : this.db.prepare("SELECT * FROM sprint_items WHERE sprint_id = ? AND lane = ? ORDER BY idx").all(sprintId, lane)
    return rows.map(toItem)
  }

  item(sprintId: string, lane: string, idx: number): ItemRecord | null {
    const row = this.db.prepare("SELECT * FROM sprint_items WHERE sprint_id = ? AND lane = ? AND idx = ?").get(sprintId, lane, idx)
    return row ? toItem(row) : null
  }

  updateLane(sprintId: string, lane: string, patch: LanePatch): void {
    const { sets, values } = patchSql(patch, LANE_COLUMNS)
    if (!sets.length) return
    this.db.prepare(`UPDATE sprint_lanes SET ${sets.join(", ")} WHERE sprint_id = ? AND lane = ?`).run(...values, sprintId, lane)
  }

  updateItem(sprintId: string, lane: string, idx: number, patch: ItemPatch): void {
    const { sets, values } = patchSql(patch, ITEM_COLUMNS)
    if (!sets.length) return
    this.db.prepare(`UPDATE sprint_items SET ${sets.join(", ")} WHERE sprint_id = ? AND lane = ? AND idx = ?`).run(...values, sprintId, lane, idx)
  }

  /** Updates the item only while it is running under this dispatch.
   *  False: it was retried, skipped or blocked since, so the caller's turn
   *  no longer owns it. */
  updateRunningItem(sprintId: string, lane: string, idx: number, dispatchId: string, patch: ItemPatch): boolean {
    const { sets, values } = patchSql(patch, ITEM_COLUMNS)
    if (!sets.length) return false
    return this.db.prepare(
      `UPDATE sprint_items SET ${sets.join(", ")} WHERE sprint_id = ? AND lane = ? AND idx = ? AND state = 'running' AND dispatch_id = ?`,
    ).run(...values, sprintId, lane, idx, dispatchId).changes > 0
  }

  /** Ended: every lane done ("done"), or stopped by the lead or the owner ("cancelled"). */
  finish(id: string, state: Exclude<SprintState, "active">, now: number): boolean {
    return this.db.prepare("UPDATE sprints SET state = ?, finished_at = ? WHERE id = ? AND state = 'active'").run(state, now, id).changes > 0
  }

  markNotified(id: string, now: number | null): void {
    this.db.prepare("UPDATE sprints SET notified_at = ? WHERE id = ?").run(now, id)
  }

  /** Finished sprints whose summary has not reached the owner yet. */
  awaitingSummary(): SprintRecord[] {
    return this.db.prepare("SELECT * FROM sprints WHERE state = 'done' AND notified_at IS NULL ORDER BY finished_at").all().map(toSprint)
  }

  event(sprintId: string, lane: string | null, idx: number | null, kind: string, detail: string, now: number): void {
    this.db.prepare("INSERT INTO sprint_events (sprint_id, lane, idx, at, kind, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sprintId, lane, idx, now, kind, detail.replace(/\s+/g, " ").trim().slice(0, DETAIL_MAX))
  }

  events(sprintId: string, limit = 200): SprintEvent[] {
    return (this.db.prepare(
      "SELECT sprint_id, lane, idx, at, kind, detail FROM sprint_events WHERE sprint_id = ? ORDER BY at, rowid LIMIT ?",
    ).all(sprintId, limit) as any[]).map((r) => ({ sprintId: r.sprint_id, lane: r.lane ?? null, idx: r.idx ?? null, at: r.at, kind: r.kind, detail: r.detail }))
  }
}
