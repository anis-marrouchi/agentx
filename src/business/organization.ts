import type { BusinessConfig, BusinessOrgEntry, BusinessRole } from "./config"

// --- Organization: org-chart queries and validation ---

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
}
