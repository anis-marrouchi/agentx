import type { BusinessConfig, BusinessOrgEntry, BusinessProject, BusinessRole } from "./config"

// --- Organization: org-chart queries and validation ---
//
// Phase 3 of the architectural rescue (research-rescue-plan.md §2)
// adds `canHandle`, `pmFor`, and `escalationChain` to support PM
// gating + escalation as runtime dispatch concepts. The Organization
// class becomes consumed by `decideAndCommit` in a separate commit
// (gated by a flag — flipping it mid-soak adds noise to the divergence
// signal, so the wiring lands deliberately). For now the methods are
// pure-function scaffolding ready to wire up.

export interface EmployeeProfile {
  agentId: string
  role: BusinessRole
  roleKey: string
  reportsTo?: string
  schedule: BusinessOrgEntry["schedule"]
  utilizationTarget: number
}

export class Organization {
  private employees: Map<string, EmployeeProfile> = new Map()
  private projects: Map<string, BusinessProject> = new Map()

  constructor(config: BusinessConfig) {
    for (const [agentId, entry] of Object.entries(config.orgChart)) {
      const role = config.roles[entry.role]
      if (!role) {
        throw new Error(`Org chart references unknown role "${entry.role}" for agent "${agentId}"`)
      }
      this.employees.set(agentId, {
        agentId,
        role,
        roleKey: entry.role,
        reportsTo: entry.reportsTo,
        schedule: entry.schedule,
        utilizationTarget: entry.utilizationTarget,
      })
    }

    // Validate reportsTo refs
    for (const emp of this.employees.values()) {
      if (emp.reportsTo && !this.employees.has(emp.reportsTo)) {
        throw new Error(`Agent "${emp.agentId}" reports to unknown agent "${emp.reportsTo}"`)
      }
    }

    // Cycle detection
    for (const emp of this.employees.values()) {
      const seen = new Set<string>()
      let cur: string | undefined = emp.agentId
      while (cur) {
        if (seen.has(cur)) {
          throw new Error(`Reporting cycle detected involving "${emp.agentId}"`)
        }
        seen.add(cur)
        cur = this.employees.get(cur)?.reportsTo
      }
    }

    // Per-project config — Phase 3.
    for (const proj of config.projects ?? []) {
      // Validate referenced PM exists in the org chart.
      if (proj.pm && !this.employees.has(proj.pm)) {
        throw new Error(`Project "${proj.id}" lists unknown PM "${proj.pm}"`)
      }
      this.projects.set(proj.id, proj)
    }
  }

  get(agentId: string): EmployeeProfile | undefined {
    return this.employees.get(agentId)
  }

  all(): EmployeeProfile[] {
    return [...this.employees.values()]
  }

  reportsTo(agentId: string): string | undefined {
    return this.employees.get(agentId)?.reportsTo
  }

  directReports(agentId: string): string[] {
    return [...this.employees.values()]
      .filter((e) => e.reportsTo === agentId)
      .map((e) => e.agentId)
  }

  /** Walk up the org tree to the root. First element is `agentId` itself. */
  chainOfCommand(agentId: string): string[] {
    const chain: string[] = []
    let cur: string | undefined = agentId
    while (cur && !chain.includes(cur)) {
      chain.push(cur)
      cur = this.employees.get(cur)?.reportsTo
    }
    return chain
  }

  /**
   * Phase 3 — PM lookup. Returns the agentId of the PM responsible
   * for `project`, or `undefined` when no PM is configured. The
   * dispatcher's PM gate (in a future commit) calls this before
   * dispatching to make sure project-scoped events flow through the
   * PM first. When undefined, dispatches proceed without a PM gate
   * (the legacy direct-routing behavior).
   */
  pmFor(project: string | null | undefined): string | undefined {
    if (!project) return undefined
    return this.projects.get(project)?.pm
  }

  /**
   * Phase 3 — escalation chain. Returns agents to escalate to in
   * upward order, EXCLUDING the agent itself. `chainOfCommand`
   * includes self at index 0; escalationChain skips that.
   *
   * Used when an agent fails / declines / times out — the dispatcher
   * walks up the chain looking for someone to take over.
   */
  escalationChain(agentId: string): string[] {
    return this.chainOfCommand(agentId).slice(1)
  }

  /**
   * Phase 3 — capability check (scaffold). Returns true when:
   *   - The org chart is empty (`employees.size === 0`) — this is the
   *     permissive default for partially-configured `business` blocks
   *     that populate `projects[].pm` for the PM gate but haven't
   *     filled in `orgChart`. Without this fallback, enabling business
   *     with an empty orgChart would block every dispatch.
   *   - OR the agent is registered in the org chart.
   *
   * Per-project / per-intent restrictions need typed capabilities
   * (Phase 5); until then this is a permissive-when-unconfigured
   * default that matches the legacy any-registered-agent-can-handle-
   * anything behavior.
   *
   * The `decideAndCommit` PM gate will call this *after* the PM
   * approves — the PM provides the project-scoped check, this
   * provides the agent-existence check.
   */
  canHandle(agentId: string, _project: string | null | undefined, _intent: string | null | undefined): boolean {
    if (this.employees.size === 0) return true
    return this.employees.has(agentId)
  }
}
