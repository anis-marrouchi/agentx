import type { AgentRegistry } from "@/agents/registry"
import type { MessageRouter } from "@/channels/router"
import type { DaemonConfig } from "@/daemon/config"
import type { BusinessConfig } from "./config"
import { Organization } from "./organization"
import { Schedule } from "./schedule"
import { createWorkSource, type WorkSource } from "./work-pool"
import { Reporter } from "./reporter"
import { KPI } from "./kpi"
import { DayCycle } from "./day-cycle"
import { handleBusinessHttp, type BusinessHttpDeps } from "./http"
import type { IncomingMessage, ServerResponse } from "http"

export { businessToolsDoc } from "./http"
export type { BusinessConfig } from "./config"

/**
 * Business layer facade — constructed once by the daemon when
 * config.business?.enabled is true.
 */
export class BusinessLayer {
  public readonly org: Organization
  public readonly schedule: Schedule
  public readonly workSource: WorkSource
  public readonly reporter: Reporter
  public readonly kpi: KPI
  public readonly dayCycle: DayCycle

  constructor(
    business: BusinessConfig,
    daemon: DaemonConfig,
    registry: AgentRegistry,
    router: MessageRouter,
    log: (...args: unknown[]) => void,
  ) {
    this.org = new Organization(business)
    this.schedule = new Schedule(this.org, business)
    this.workSource = createWorkSource(business, daemon, log)
    this.reporter = new Reporter(router, this.org, business, log)
    this.kpi = new KPI(this.org, this.schedule, log)

    // Prefer loopback URL for local agents; external agents can override via env.
    const [host, port] = daemon.node.bind.split(":")
    const daemonBase = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port || "18800"}`

    this.dayCycle = new DayCycle(
      business, this.org, this.schedule, registry, this.reporter, this.kpi, this.workSource, daemonBase, log,
    )
  }

  start(): void {
    this.dayCycle.start()
  }

  stop(): void {
    this.dayCycle.stop()
  }

  /** Record a task completion (called by router when an agent finishes a task). */
  recordTaskCompletion(agentId: string, durationSeconds: number, success: boolean, channel?: string): void {
    this.kpi.recordTaskCompletion({ agentId, durationSeconds, success, channel })
  }

  async handleHttp(route: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const deps: BusinessHttpDeps = {
      workSource: this.workSource,
      org: this.org,
      schedule: this.schedule,
      reporter: this.reporter,
      kpi: this.kpi,
    }
    return handleBusinessHttp(route, req, res, deps)
  }

  /** Short startup banner line. */
  summary(): string {
    const onClock = this.schedule.clockedInAgents().length
    return `Business layer: ${this.org.all().length} employees, ${onClock} on-clock now`
  }
}
