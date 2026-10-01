import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { resolve } from "path"
import { z } from "zod"
import { runAction } from "@/actions/runner"
import { ActionStore } from "@/actions/store"
import type { ActionRunResult } from "@/actions/types"
import type { WorkflowDispatcher } from "./dispatcher"
import { conditionMatches, getByPath } from "./engine"
import type { WorkflowStore } from "./store"
import { conditionSchema, type Workflow } from "./types"

// --- trigger.poll ---
//
// Runs a registered action on an interval and starts one run per NEW item
// it prints (one JSON object per line). The engine keeps the "already
// seen" keys, so the command can be a plain "list the latest N" call.
//
//   - Seen keys live in <workflows dir>/_poll/<workflowId>.json and survive
//     a restart. A key is written BEFORE its run is dispatched: an item
//     starts at most one run, even if the daemon dies mid-poll.
//   - The first poll (no state, or actionId/key changed) only records a
//     baseline; old items start nothing.
//   - A poll with nothing new dispatches nothing, so it leaves no run record.
//   - A failing or timed-out command is logged and retried on the next tick.
//     The action must exit non-zero when its source fails: an empty success
//     on the first poll records an empty baseline.
//
// Timers follow the workflow files: sync() starts a timer for every active
// trigger.poll workflow and stops the ones that are gone, disabled or
// quarantined. Each tick re-reads the workflow, so config edits apply on
// the next poll.

export const pollConfigSchema = z.object({
  /** Registered action (.agentx/actions/<id>.json) that prints the items. */
  actionId: z.string().min(1),
  everySeconds: z.number().int().min(5).max(86_400).default(60),
  /** Dotted path of the field that identifies an item. */
  key: z.string().min(1).default("id"),
  /** Same condition kinds as `branch`, paths relative to the item. All
   *  must match. A filtered-out item is still recorded as seen. */
  filter: z.array(conditionSchema).default([]),
  /** Most runs one poll may start. The rest stay unseen for the next poll. */
  maxPerPoll: z.number().int().min(1).max(500).default(20),
})
export type PollConfig = z.infer<typeof pollConfigSchema>

/** Seen keys kept per workflow. Keys still in the command's output are
 *  never dropped, whatever the count. */
const MAX_SEEN = 5000

interface PollState { actionId: string; key: string; seen: string[] }

export interface PollTriggersOptions {
  store: Pick<WorkflowStore, "list" | "get" | "baseDir">
  dispatcher: Pick<WorkflowDispatcher, "dispatchWorkflow">
  log: (msg: string) => void
  /** Runs the poll action. Default: look it up in the action registry. */
  runAction?: (actionId: string) => Promise<ActionRunResult>
}

/** How often start() re-reads the workflow files, so a workflow saved,
 *  enabled or disabled by any process (editor, CLI, a copied file) is
 *  picked up without a restart. */
const RESYNC_SECONDS = 30

async function runRegisteredAction(actionId: string): Promise<ActionRunResult> {
  const action = new ActionStore().get(actionId)
  if (!action) throw new Error(`no action "${actionId}" in registry`)
  return runAction(action)
}

/** Parse the command's stdout: one JSON object per line. Lines that are not
 *  an object, or carry no string/number at `keyPath`, are skipped. */
export function parsePollItems(output: string, keyPath: string): { items: Array<{ key: string; value: Record<string, unknown> }>; skipped: number } {
  const items: Array<{ key: string; value: Record<string, unknown> }> = []
  let skipped = 0
  for (const line of output.split("\n")) {
    const text = line.trim()
    if (!text) continue
    let value: unknown
    try { value = JSON.parse(text) } catch { skipped++; continue }
    if (!value || typeof value !== "object" || Array.isArray(value)) { skipped++; continue }
    const key = getByPath(value, keyPath)
    if ((typeof key !== "string" || !key) && typeof key !== "number") { skipped++; continue }
    items.push({ key: String(key), value: value as Record<string, unknown> })
  }
  return { items, skipped }
}

/** Entity id of one item's run. The run index keeps only [a-zA-Z0-9._:#@-]
 *  and the first 200 characters, so a key outside that is hashed: two keys
 *  must never share an index entry. A plain key holds no "#", so it cannot
 *  equal a hashed one. */
export function pollEntityId(workflowId: string, key: string): string {
  const plain = `${workflowId}:${key}`
  if (/^[a-zA-Z0-9._:@-]+$/.test(key) && plain.length <= 200) return plain
  return `${workflowId}:#${createHash("sha256").update(key).digest("hex").slice(0, 32)}`
}

export class PollTriggers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Last warning per workflow, so a standing problem logs once, not every tick. */
  private readonly warned = new Map<string, string>()
  private readonly stateDir: string
  private readonly runAction: (actionId: string) => Promise<ActionRunResult>
  private resync?: ReturnType<typeof setInterval>

  constructor(private readonly opts: PollTriggersOptions) {
    this.stateDir = resolve(opts.store.baseDir, "_poll")
    this.runAction = opts.runAction ?? runRegisteredAction
  }

  /** sync() now and every RESYNC_SECONDS. Returns the number polling. */
  start(): number {
    this.resync ??= setInterval(() => {
      try { this.sync() } catch (e: any) { this.opts.log(`[workflows] poll sync failed: ${e.message}`) }
    }, RESYNC_SECONDS * 1000)
    return this.sync()
  }

  /** Match timers to the workflows on disk. Returns the number polling. */
  sync(): number {
    const wanted = new Map<string, PollConfig>()
    for (const wf of this.opts.store.list()) {
      const cfg = this.configOf(wf)
      if (cfg) wanted.set(wf.id, cfg)
    }
    for (const [id, timer] of this.timers) {
      if (wanted.has(id)) continue
      clearTimeout(timer)
      this.timers.delete(id)
      this.opts.log(`[workflows] ${id} poll stopped`)
    }
    for (const [id, cfg] of wanted) {
      if (this.timers.has(id)) continue
      this.schedule(id, cfg.everySeconds)
      this.opts.log(`[workflows] ${id} polls action "${cfg.actionId}" every ${cfg.everySeconds}s`)
    }
    return this.timers.size
  }

  stop(): void {
    if (this.resync) clearInterval(this.resync)
    this.resync = undefined
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /** One poll. Returns the number of runs started. */
  async pollOnce(workflowId: string): Promise<number> {
    const wf = this.opts.store.get(workflowId)
    const cfg = wf ? this.configOf(wf) : null
    if (!cfg) return 0

    let result: ActionRunResult
    try { result = await this.runAction(cfg.actionId) }
    catch (e: any) { this.warnOnce(workflowId, `poll failed: ${e.message}`); return 0 }
    if (!result.ok) {
      this.warnOnce(workflowId, `poll failed (status=${result.status ?? "?"}): ${(result.errors ?? "").slice(0, 200)}`)
      return 0
    }

    const { items, skipped } = parsePollItems(result.output, cfg.key)
    this.warnOnce(workflowId, skipped > 0 ? `poll skipped ${skipped} line(s) that are not a JSON object with "${cfg.key}"` : "")

    const current = new Set(items.map((i) => i.key))
    const state = this.readState(workflowId)
    if (!state || state.actionId !== cfg.actionId || state.key !== cfg.key) {
      this.writeState(workflowId, { actionId: cfg.actionId, key: cfg.key, seen: [...current] }, current)
      this.opts.log(`[workflows] ${workflowId} poll baseline: ${current.size} existing item(s) recorded, no runs started`)
      return 0
    }

    const seen = new Set(state.seen)
    let started = 0
    let dirty = false
    for (const item of items) {
      if (seen.has(item.key)) continue
      const matches = cfg.filter.every((c) => conditionMatches(c, item.value))
      if (matches && started >= cfg.maxPerPoll) continue
      seen.add(item.key)
      state.seen.push(item.key)
      if (!matches) { dirty = true; continue }
      // Record the key first: a crash from here on loses the item rather
      // than running it twice.
      this.writeState(workflowId, state, current)
      dirty = false
      try {
        const { run } = await this.opts.dispatcher.dispatchWorkflow({
          workflowId,
          trigger: { source: "poll" },
          entityRef: { backend: "poll", id: pollEntityId(workflowId, item.key) },
          event: { id: `poll:${workflowId}:${item.key}`, payload: item.value },
        })
        if (run) started++
        else this.opts.log(`[workflows] ${workflowId} poll item "${item.key}" started no run`)
      } catch (e: any) {
        this.opts.log(`[workflows] ${workflowId} poll dispatch failed for "${item.key}": ${e.message}`)
      }
    }
    if (dirty) this.writeState(workflowId, state, current)
    return started
  }

  private schedule(workflowId: string, everySeconds: number): void {
    const timer = setTimeout(() => {
      void (async () => {
        try { await this.pollOnce(workflowId) }
        catch (e: any) { this.opts.log(`[workflows] ${workflowId} poll failed: ${e.message}`) }
        // Stopped, or restarted by sync() while this poll ran: not our chain.
        if (this.timers.get(workflowId) !== timer) return
        const wf = this.opts.store.get(workflowId)
        const cfg = wf ? this.configOf(wf) : null
        if (cfg) this.schedule(workflowId, cfg.everySeconds)
        else this.timers.delete(workflowId)
      })()
    }, everySeconds * 1000)
    this.timers.set(workflowId, timer)
  }

  /** The poll config of an ACTIVE trigger.poll workflow, else null. */
  private configOf(wf: Workflow): PollConfig | null {
    if (wf.state && wf.state !== "active") return null
    const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
    if (!trigger || trigger.type !== "trigger.poll") return null
    const parsed = pollConfigSchema.safeParse(trigger.config)
    if (!parsed.success) {
      const why = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")
      this.warnOnce(wf.id, `trigger.poll config invalid, not polling (${why})`)
      return null
    }
    return parsed.data
  }

  private warnOnce(workflowId: string, msg: string): void {
    if (this.warned.get(workflowId) === msg) return
    this.warned.set(workflowId, msg)
    if (msg) this.opts.log(`[workflows] ${workflowId} ${msg}`)
  }

  private statePath(workflowId: string): string {
    return resolve(this.stateDir, `${workflowId}.json`)
  }

  private readState(workflowId: string): PollState | null {
    const file = this.statePath(workflowId)
    if (!existsSync(file)) return null
    try {
      const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<PollState>
      if (typeof raw.actionId !== "string" || typeof raw.key !== "string" || !Array.isArray(raw.seen)) return null
      return { actionId: raw.actionId, key: raw.key, seen: raw.seen.map(String) }
    } catch { return null }
  }

  /** Atomic write (tmp + rename). Trims `seen` to MAX_SEEN, oldest first,
   *  keeping every key the command still prints. */
  private writeState(workflowId: string, state: PollState, current: Set<string>): void {
    let drop = state.seen.length - MAX_SEEN
    if (drop > 0) state.seen = state.seen.filter((k) => current.has(k) || drop-- <= 0)
    mkdirSync(this.stateDir, { recursive: true })
    const file = this.statePath(workflowId)
    writeFileSync(`${file}.tmp`, JSON.stringify(state))
    renameSync(`${file}.tmp`, file)
  }
}
