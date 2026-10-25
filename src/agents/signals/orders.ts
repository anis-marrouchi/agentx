import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"

// --- One report for a stop-all across the mesh (#1328) ---
//
// The owner's `stop --all --mesh` is one order. The node it was given on is
// the order's coordinator: it sends the order on with its own order id and
// its name to report to, and keeps a file listing the peers that took it.
// Each peer keeps a file saying whom to report to. After the restart:
//   - a peer resumes its tasks, then sends what happened to each one to the
//     coordinator, instead of telling the owner itself. When the
//     coordinator cannot be reached for a while, it tells the owner itself,
//     so nothing goes unreported;
//   - the coordinator waits for its own pass and every peer's part, then
//     sends the owner one report for every task on every node. A part that
//     has not come within REPORT_WAIT_MS is named as missing; one that comes
//     later is sent on its own, as a late part.
// A stop-all without --mesh keeps one report per node, as before.

/** What the boot pass did with one stop-all task (#1271). */
export interface StopAllOutcome {
  id: string
  agentId: string
  decision: "resumed" | "resume-failed" | "skipped"
  reason: string
  /** The order that stopped it. */
  orderId?: string
  /** Background builders the stop also stopped (#1328). */
  builders?: number
  /** Branches their unsaved work was saved on. */
  wip?: string[]
}

export interface OrderPeer {
  /** Its name in this node's mesh directory. */
  name: string
  /** Its own node name, as it answered. */
  node?: string
}

export interface OrderPart {
  at: string
  outcomes: StopAllOutcome[]
}

export interface MeshOrder {
  orderId: string
  role: "coordinator" | "member"
  createdAt: string
  /** coordinator: the peers that took the order. */
  peers?: OrderPeer[]
  /** member: the node to report to. */
  coordinator?: string
  /** coordinator: each node's part, by node name, its own included. */
  parts?: Record<string, OrderPart>
  /** coordinator: when the report went to the owner. member: when its part
   *  reached the coordinator, or the owner when it could not. */
  sentAt?: string
}

const KEEP_MS = 7 * 24 * 60 * 60 * 1000
export const REPORT_WAIT_MS = 10 * 60_000
const MEMBER_RETRY_MS = 30_000
const MEMBER_TRIES = 20
const MAX_OUTCOMES = 200

/** An order id a peer may send: the coordinator's `stop-all-<digits>`. */
export function validOrderId(v: unknown): string | undefined {
  return typeof v === "string" && /^stop-all-[0-9]{8,20}$/.test(v) ? v : undefined
}

export class StopAllOrderStore {
  constructor(private dir: string) {}

  private file(orderId: string): string {
    return resolve(this.dir, `${orderId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
  }

  save(order: MeshOrder): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    const path = this.file(order.orderId)
    writeFileSync(`${path}.tmp`, JSON.stringify(order, null, 2), "utf-8")
    renameSync(`${path}.tmp`, path)
  }

  get(orderId: string): MeshOrder | null {
    try { return JSON.parse(readFileSync(this.file(orderId), "utf-8")) as MeshOrder } catch { return null }
  }

  /** Every order kept; drops ones older than a week. */
  list(now = Date.now()): MeshOrder[] {
    if (!existsSync(this.dir)) return []
    const out: MeshOrder[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue
      let o: MeshOrder
      try { o = JSON.parse(readFileSync(resolve(this.dir, name), "utf-8")) } catch { continue }
      if (now - Date.parse(o.createdAt) > KEEP_MS) {
        try { unlinkSync(resolve(this.dir, name)) } catch { /* next list retries */ }
        continue
      }
      out.push(o)
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}

function outcomeLine(o: StopAllOutcome): string {
  const extra: string[] = []
  if (o.decision !== "resumed") extra.push(o.reason)
  if (o.builders) extra.push(`${o.builders} builder(s)${o.wip?.length ? `, work saved on ${o.wip.join(", ")}` : ""}`)
  return `- ${o.agentId} ${o.id}: ${o.decision === "resume-failed" ? "failed" : o.decision}${extra.length ? ` (${extra.join("; ")})` : ""}`
}

function countLine(outcomes: StopAllOutcome[]): string {
  const count = (d: StopAllOutcome["decision"]) => outcomes.filter((o) => o.decision === d).length
  return `${count("resumed")} resumed, ${count("resume-failed")} failed, ${count("skipped")} skipped`
}

/** The task lines of one node, by agent. */
export function outcomeLines(outcomes: StopAllOutcome[]): string[] {
  const lines: string[] = []
  for (const agent of [...new Set(outcomes.map((o) => o.agentId))].sort()) {
    for (const o of outcomes.filter((x) => x.agentId === agent)) lines.push(outcomeLine(o))
  }
  return lines
}

const HAND_RESUME = "Resume one by hand with: agentx signal resume <id> (add --peer <machine> for another machine)"

/** The one message for a mesh order: every node's tasks, and the nodes
 *  that sent nothing. */
export function meshStopAllReport(input: {
  orderId: string
  nodes: Array<{ node: string; outcomes?: StopAllOutcome[]; missing?: string }>
  late?: boolean
}): string {
  const all = input.nodes.flatMap((n) => n.outcomes ?? [])
  const head = input.late
    ? `Late part of the stop-all ${input.orderId}:`
    : `After the stop-all ${input.orderId} on ${input.nodes.length} machine(s): ${countLine(all)}.`
  const lines = [head]
  for (const n of input.nodes) {
    if (!n.outcomes) { lines.push(`${n.node}: no report (${n.missing ?? "not heard from"})`); continue }
    if (!n.outcomes.length) { lines.push(`${n.node}: nothing was running`); continue }
    lines.push(`${n.node}: ${countLine(n.outcomes)}`, ...outcomeLines(n.outcomes))
  }
  if (all.some((o) => o.decision !== "resumed")) lines.push(HAND_RESUME)
  return lines.join("\n")
}

export interface ReporterDeps {
  store: StopAllOrderStore
  selfNode: string
  /** Send this node's part to the coordinator (which knows the sender by
   *  its mesh identity). Throws when it did not arrive; with `status` set
   *  to the HTTP status when the coordinator answered with an error. */
  sendPart(coordinator: string, body: { orderId: string; outcomes: StopAllOutcome[] }): Promise<void>
  /** One message to the owner. */
  tellOwner(text: string): Promise<void>
  /** The report of a node's own tasks, for a member that cannot reach its
   *  coordinator and for orders without --mesh. */
  ownReport(outcomes: StopAllOutcome[]): string | null
  log(msg: string): void
  now?(): number
  /** Overridable in tests. */
  waitMs?: number
  retryMs?: number
}

export class StopAllReporter {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number

  constructor(private deps: ReporterDeps) {
    this.now = deps.now ?? Date.now
  }

  /** The coordinator's order, once its peers took it. */
  begin(orderId: string, peers: OrderPeer[]): void {
    if (!peers.length) return
    this.save({ orderId, role: "coordinator", createdAt: new Date(this.now()).toISOString(), peers, parts: {} })
  }

  /** A member's order: report to `coordinator` after the restart. */
  join(orderId: string, coordinator: string): void {
    if (this.deps.store.get(orderId)) return
    this.save({ orderId, role: "member", createdAt: new Date(this.now()).toISOString(), coordinator })
  }

  /** Whether a stop-all task is reported through a mesh order. */
  owns(orderId: string | undefined): boolean {
    return !!orderId && !!this.deps.store.get(orderId)
  }

  /** At boot, after resumeStopAll(): send each part where it belongs. Never
   *  throws. Resolves once every report is sent or handed to a timer; a
   *  member's retries go on in the background (`retries`, for tests). */
  async afterBoot(outcomes: StopAllOutcome[]): Promise<{ retries: Promise<void>[] }> {
    const retries: Promise<void>[] = []
    const local: StopAllOutcome[] = []
    const orders = this.deps.store.list(this.now())
    const byId = new Map(orders.map((o) => [o.orderId, o]))
    for (const o of outcomes) if (!o.orderId || !byId.has(o.orderId)) local.push(o)
    try {
      const text = local.length ? this.deps.ownReport(local) : null
      if (text) await this.deps.tellOwner(text)
    } catch (e: any) { this.deps.log(`[signals] stop-all report failed: ${e?.message ?? e}`) }

    for (const order of orders) {
      const mine = outcomes.filter((o) => o.orderId === order.orderId).slice(0, MAX_OUTCOMES)
      try {
        if (order.role === "member") {
          if (order.sentAt) continue
          retries.push(this.sendMember(order, mine))
        } else {
          await this.addPart(order.orderId, this.deps.selfNode, mine)
        }
      } catch (e: any) {
        this.deps.log(`[signals] stop-all ${order.orderId}: report failed: ${e?.message ?? e}`)
      }
    }
    return { retries }
  }

  /** A peer's part, sent to /api/signals/stop-all/report. */
  async receive(peer: string, body: Record<string, unknown>): Promise<{ status: number; error?: string }> {
    const orderId = validOrderId(body.orderId)
    if (!orderId) return { status: 400, error: "send { orderId, outcomes }" }
    const order = this.deps.store.get(orderId)
    if (!order || order.role !== "coordinator") return { status: 404, error: `no mesh stop-all ${orderId} on this node` }
    const want = peer.toLowerCase()
    const match = order.peers?.find((p) => p.name.toLowerCase() === want || p.node?.toLowerCase() === want)
    if (!match) return { status: 403, error: `${peer} did not take the stop-all ${orderId}` }
    const outcomes = Array.isArray(body.outcomes) ? (body.outcomes as unknown[]).slice(0, MAX_OUTCOMES).map(cleanOutcome).filter((o): o is StopAllOutcome => !!o) : []
    await this.addPart(orderId, match.node ?? match.name, outcomes)
    return { status: 200 }
  }

  /** Clear the timers (daemon shutdown). */
  close(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private async addPart(orderId: string, node: string, outcomes: StopAllOutcome[]): Promise<void> {
    const order = this.deps.store.get(orderId)
    if (!order || order.role !== "coordinator") return
    // The first part of a node stands: a later boot of it has resumed
    // nothing of this order, and would only erase what the first said.
    if (order.parts?.[node]) {
      if (!order.sentAt) this.arm(order)
      return
    }
    order.parts = { ...order.parts, [node]: { at: new Date(this.now()).toISOString(), outcomes } }
    this.save(order)
    if (order.sentAt) {
      // The report went already: a part that comes now is sent on its own.
      await this.deps.tellOwner(meshStopAllReport({ orderId, nodes: [{ node, outcomes }], late: true }))
      return
    }
    if (this.expected(order).every((n) => order.parts?.[n])) { await this.send(order); return }
    this.arm(order)
  }

  /** Every node whose part the report waits for, the coordinator first. */
  private expected(order: MeshOrder): string[] {
    return [this.deps.selfNode, ...(order.peers ?? []).map((p) => p.node ?? p.name)]
  }

  private arm(order: MeshOrder): void {
    if (this.timers.has(order.orderId)) return
    const t = setTimeout(() => {
      this.timers.delete(order.orderId)
      const latest = this.deps.store.get(order.orderId)
      if (latest && !latest.sentAt) void this.send(latest).catch((e: any) => this.deps.log(`[signals] stop-all ${order.orderId}: report failed: ${e?.message ?? e}`))
    }, this.deps.waitMs ?? REPORT_WAIT_MS)
    t.unref?.()
    this.timers.set(order.orderId, t)
  }

  private async send(order: MeshOrder): Promise<void> {
    const t = this.timers.get(order.orderId)
    if (t) { clearTimeout(t); this.timers.delete(order.orderId) }
    const wait = Math.round((this.deps.waitMs ?? REPORT_WAIT_MS) / 60_000)
    const nodes = this.expected(order).map((node) => {
      const part = order.parts?.[node]
      if (part) return { node, outcomes: part.outcomes }
      return {
        node,
        missing: node === this.deps.selfNode
          ? "this machine has not restarted yet; its tasks resume when it does"
          : `nothing within ${wait} min; it may not have restarted yet. Check with: agentx signal list --peer ${node}`,
      }
    })
    // Marked first: a second part racing this one goes out as a late part.
    this.save({ ...order, sentAt: new Date(this.now()).toISOString() })
    await this.deps.tellOwner(meshStopAllReport({ orderId: order.orderId, nodes }))
    this.deps.log(`[signals] stop-all ${order.orderId}: one report sent for ${nodes.length} machine(s)`)
  }

  private async sendMember(order: MeshOrder, outcomes: StopAllOutcome[]): Promise<void> {
    const tries = MEMBER_TRIES
    let last = ""
    for (let i = 0; i < tries; i++) {
      try {
        await this.deps.sendPart(order.coordinator!, { orderId: order.orderId, outcomes })
        this.save({ ...order, sentAt: new Date(this.now()).toISOString() })
        this.deps.log(`[signals] stop-all ${order.orderId}: ${outcomes.length} task(s) reported to ${order.coordinator}`)
        return
      } catch (e: any) {
        last = String(e?.message ?? e)
        // The coordinator refused the part (it does not know this order,
        // or that this node took it): asking again changes nothing.
        if (refusal(e?.status)) break
      }
      if (i < tries - 1) await new Promise((r) => { const t = setTimeout(r, this.deps.retryMs ?? MEMBER_RETRY_MS); t.unref?.() })
    }
    // Never silent: the owner hears from this node itself.
    this.save({ ...order, sentAt: new Date(this.now()).toISOString() })
    this.deps.log(`[signals] stop-all ${order.orderId}: couldn't reach ${order.coordinator} (${last}); telling the owner directly`)
    const own = this.deps.ownReport(outcomes) ?? `After the stop-all on ${this.deps.selfNode}: nothing was running.`
    try {
      await this.deps.tellOwner(`${own}\n(Sent by ${this.deps.selfNode} itself: ${order.coordinator} could not be reached for the combined report of ${order.orderId}.)`)
    } catch (e: any) { this.deps.log(`[signals] stop-all report failed: ${e?.message ?? e}`) }
  }

  private save(order: MeshOrder): void {
    try { this.deps.store.save(order) } catch (e: any) { this.deps.log(`[signals] couldn't save stop-all ${order.orderId}: ${e?.message ?? e}`) }
  }
}

/** A 4xx a retry cannot change: not 408 (timeout) or 429 (too many). */
function refusal(status: unknown): boolean {
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "")

/** A peer's outcome, bounded; null when it is not one. */
function cleanOutcome(v: unknown): StopAllOutcome | null {
  if (!v || typeof v !== "object") return null
  const o = v as Record<string, unknown>
  const decision = o.decision === "resumed" || o.decision === "resume-failed" || o.decision === "skipped" ? o.decision : null
  if (!decision || !str(o.id, 200) || !str(o.agentId, 100)) return null
  return {
    id: str(o.id, 200),
    agentId: str(o.agentId, 100),
    decision,
    reason: str(o.reason, 300),
    ...(typeof o.builders === "number" && o.builders > 0 ? { builders: Math.min(Math.floor(o.builders), 100) } : {}),
    ...(Array.isArray(o.wip) ? { wip: o.wip.slice(0, 10).map((b) => str(b, 120)).filter(Boolean) } : {}),
  }
}
