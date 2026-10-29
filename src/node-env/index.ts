// --- The node as the source of truth for its own environment (#1531) ---
//
// Agents ask the node about the machine, its programs, the Claude account
// and what runs right now, instead of keeping their own copy: a copy goes
// stale (an hour-old "weekly limit, resets tomorrow" note was repeated as
// true after the account had recovered). GET /api/node, `agentx node` and
// the MCP tool `agentx_node` all serve this one report.
//
// Every section carries the time it was read:
//   host     OS and hardware, read at boot; live memory, swap, disk and
//            load from the admission sampler (no second reader)
//   tools    versions of the programs in `environment.tools`, read at boot
//            and every `environment.toolsRefreshHours`, never per request
//   account  what Claude Code last reported: plan windows with reset
//            times, active holds, holds lifted in the last day, and the
//            credential its last session ran on
//   work     the admission snapshot: running, waiting, next

import { lastClaudeSessionInit, liftedProviderHolds, activeProviderHolds, getClaudeCodeUsage, type LiftedHold, type RateLimitSignal } from "@/agents/claude-code-quota"
import type { AdmissionSnapshot } from "@/admission/queue"
import type { DaemonConfig } from "@/daemon/config"
import { detectHost, type HostInfo } from "@/native/host-info"
import type { ResourceSample } from "@/native/resources"
import { readToolVersion, type ToolVersion } from "@/native/tool-version"

export type EnvironmentSettings = DaemonConfig["environment"]

export interface ToolReport extends ToolVersion {
  name: string
  command: string
  checkedAt: string
}

export interface PlanWindow {
  window: string
  status: RateLimitSignal["status"]
  resetsAt: string | null
  /** 0..100, when reported. */
  usedPercent: number | null
  usingOverage: boolean
  /** When Claude Code last reported this window. */
  reportedAt: string
}

export interface NodeReport {
  /** When this report was put together. */
  checkedAt: string
  node: { id: string; name: string; version: string | null; commit: string | null; startedAt: string }
  host: (Omit<HostInfo, "checkedAt"> & {
    checkedAt: string
    live: (Omit<ResourceSample, "at"> & { checkedAt: string }) | null
  }) | null
  tools: { checkedAt: string | null; nextCheckAt: string | null; items: ToolReport[] }
  account: {
    provider: "claude"
    /** The newest report from Claude Code; null when no session ran since boot. */
    checkedAt: string | null
    /** Agents per billing mode: "subscription" (the /login account) or "api" (a key). */
    billing: { subscription: string[]; api: string[] }
    /** The credential and CLI version Claude Code's last session started with. */
    lastSession: { agentId: string | null; credential: string | null; cliVersion: string | null; model: string | null; checkedAt: string } | null
    windows: PlanWindow[]
    /** Windows that hold cold dispatches now. */
    holds: Array<{ window: string; since: string; until: string | null; reportedAt: string }>
    /** Holds that ended in the last day, so a recovery is visible. */
    lifted: Array<{ window: string; heldSince: string; liftedAt: string; how: LiftedHold["how"] }>
    /** Local dispatch counters (runs started in the last hour / 5 hours). */
    dispatches: { lastHour: number; last5h: number; maxPerHour: number | null; maxPer5h: number | null; checkedAt: string }
  }
  work: AdmissionSnapshot | null
}

export interface NodeEnvironmentDeps {
  config: () => Pick<DaemonConfig, "node" | "agents" | "environment">
  admission?: { refresh(): Promise<void>; snapshot(): AdmissionSnapshot }
  build?: { version: string | null; commit: string | null; startedAt: string }
  log?: (m: string) => void
  now?: () => number
  detectHost?: (now: number) => Promise<HostInfo>
  readTool?: (command: string, args: string[]) => Promise<ToolVersion>
}

const iso = (ms: number) => new Date(ms).toISOString()

function toolSpec(t: EnvironmentSettings["tools"][number]): { name: string; command: string; args: string[] } {
  if (typeof t === "string") return { name: t, command: t, args: ["--version"] }
  return { name: t.name, command: t.command || t.name, args: t.args ?? ["--version"] }
}

export class NodeEnvironment {
  private host: HostInfo | null = null
  private tools: ToolReport[] = []
  private toolsAt: number | null = null
  private toolsPending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private readonly now: () => number

  constructor(private readonly deps: NodeEnvironmentDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Read the host and the tools now, then the tools again on a timer. */
  async start(): Promise<void> {
    this.stopped = false
    await Promise.all([this.readHost(), this.readTools()])
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private settings(): EnvironmentSettings {
    const e = this.deps.config().environment
    return e ?? { tools: [], toolsRefreshHours: 6 }
  }

  private schedule(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    const ms = Math.max(0.25, this.settings().toolsRefreshHours) * 3_600_000
    this.timer = setTimeout(() => { this.timer = null; void this.readTools().finally(() => this.schedule()) }, ms)
    this.timer.unref?.()
  }

  async readHost(): Promise<void> {
    try {
      this.host = await (this.deps.detectHost ?? detectHost)(this.now())
    } catch (e: any) {
      this.deps.log?.(`[node] could not read the host: ${e?.message ?? e}`)
    }
  }

  /** Read every configured tool's version. Concurrent calls share one read. */
  readTools(): Promise<void> {
    if (this.toolsPending) return this.toolsPending
    const read = this.deps.readTool ?? ((c: string, a: string[]) => readToolVersion(c, a))
    const specs = this.settings().tools.map(toolSpec)
    this.toolsPending = Promise.all(specs.map(async (s) => {
      const v = await read(s.command, s.args).catch((e: any) => ({ found: false, version: null, raw: null, error: String(e?.message ?? e) } as ToolVersion))
      return { name: s.name, command: [s.command, ...s.args].join(" "), ...v, checkedAt: iso(this.now()) }
    })).then((items) => {
      this.tools = items
      this.toolsAt = this.now()
    }).finally(() => { this.toolsPending = null })
    return this.toolsPending
  }

  /** The whole report. Reads live resources; never re-reads the tools. */
  async report(): Promise<NodeReport> {
    if (this.deps.admission) await this.deps.admission.refresh().catch(() => {})
    const work = this.deps.admission?.snapshot() ?? null
    const now = this.now()
    const cfg = this.deps.config()
    const live = work?.resources ?? null
    const build = this.deps.build ?? { version: null, commit: null, startedAt: iso(now) }
    const refreshMs = Math.max(0.25, this.settings().toolsRefreshHours) * 3_600_000
    return {
      checkedAt: iso(now),
      node: { id: cfg.node.id, name: cfg.node.name, ...build },
      host: this.host ? { ...this.host, live: live ? liveReading(live) : null } : null,
      tools: {
        checkedAt: this.toolsAt === null ? null : iso(this.toolsAt),
        nextCheckAt: this.toolsAt === null ? null : iso(this.toolsAt + refreshMs),
        items: this.tools,
      },
      account: accountReport(cfg.agents, now),
      work,
    }
  }
}

function liveReading(r: ResourceSample): Omit<ResourceSample, "at"> & { checkedAt: string } {
  const { at, ...rest } = r
  return { ...rest, checkedAt: iso(at) }
}

/** The Claude account as Claude Code last reported it. */
export function accountReport(agents: DaemonConfig["agents"], now = Date.now()): NodeReport["account"] {
  const usage = getClaudeCodeUsage(now)
  const billing = { subscription: [] as string[], api: [] as string[] }
  for (const [id, a] of Object.entries(agents ?? {})) {
    if ((a.tier ?? "claude-code") !== "claude-code") continue
    billing[a.billing === "api" ? "api" : "subscription"].push(id)
  }
  const init = lastClaudeSessionInit()
  const seen = [...usage.provider.map((s) => s.seenAt), ...(init ? [init.seenAt] : [])]
  return {
    provider: "claude",
    checkedAt: seen.length ? iso(Math.max(...seen)) : null,
    billing,
    lastSession: init ? {
      agentId: init.agentId ?? null,
      credential: credentialLabel(init.apiKeySource),
      cliVersion: init.cliVersion ?? null,
      model: init.model ?? null,
      checkedAt: iso(init.seenAt),
    } : null,
    windows: usage.provider.map((s) => ({
      window: s.window,
      status: s.status,
      resetsAt: s.resetsAt ? iso(s.resetsAt) : null,
      usedPercent: s.utilization === undefined ? null : Math.round(s.utilization * 100),
      usingOverage: !!s.usingOverage,
      reportedAt: iso(s.seenAt),
    })),
    holds: activeProviderHolds(now).map((s) => ({
      window: s.window, since: iso(s.seenAt), until: s.resetsAt ? iso(s.resetsAt) : null, reportedAt: iso(s.seenAt),
    })),
    lifted: liftedProviderHolds(now).map((l) => ({
      window: l.window, heldSince: iso(l.heldSince), liftedAt: iso(l.liftedAt), how: l.how,
    })),
    dispatches: {
      lastHour: usage.lastHour, last5h: usage.last5h,
      maxPerHour: usage.maxPerHour ?? null, maxPer5h: usage.maxPer5h ?? null,
      checkedAt: iso(now),
    },
  }
}

/** Claude Code's `apiKeySource`, in words. "none" is the /login subscription. */
export function credentialLabel(src: string | undefined): string | null {
  if (!src) return null
  if (src === "none") return "subscription (claude /login)"
  return `API key (${src})`
}
