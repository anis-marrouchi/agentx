import type { BusinessConfig, BusinessOrgEntry, BusinessProject, BusinessRole } from "./config"
import { memberKey, memberLabel, orgRelations, parseMember, relationsProblem, remoteAgent, type OrgRelation } from "./relations"

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
  /** Reports-to boss from the typed relations: a bare id for an agent, `person:<id>` for a person. */
  reportsTo?: string
  schedule: BusinessOrgEntry["schedule"]
  utilizationTarget: number
}

export class Organization {
  private employees: Map<string, EmployeeProfile> = new Map()
  private projects: Map<string, BusinessProject> = new Map()
  private relationList: OrgRelation[] = []
  /** Member → its reports-to boss, both written in full (`agent:x`, `person:y`). */
  private bosses: Map<string, string> = new Map()
  private people: ReadonlyArray<{ id: string; name?: string }>
  /** Relations left out because they name a node no longer in mesh.peers,
   *  one plain sentence each. The daemon logs them; the Org page shows the
   *  same problem. */
  dropped: string[] = []

  /** `people`: the top-level people list, so a person can sit in the org.
   *  `peers`: the names in mesh.peers, so `agent:<node>/<id>` may be named. */
  constructor(config: BusinessConfig, people: ReadonlyArray<{ id: string; name?: string }> = [], peers: ReadonlyArray<string> = []) {
    this.people = people
    for (const [agentId, entry] of Object.entries(config.orgChart)) {
      const role = config.roles[entry.role]
      if (!role) {
        throw new Error(`Org chart references unknown role "${entry.role}" for agent "${agentId}"`)
      }
      this.employees.set(agentId, {
        agentId,
        role,
        roleKey: entry.role,
        schedule: entry.schedule,
        utilizationTarget: entry.utilizationTarget,
      })
    }

    // Members and typed relations (#1418): reportsTo may name a person,
    // and business.relations adds reports-to, dotted-line and acts-for.
    // A peer can be removed or renamed without this check (mesh remove, the
    // admin peer delete), so a line to an agent on a node that is gone is
    // left out with a warning instead of stopping the business layer.
    const known = new Set(peers)
    this.relationList = orgRelations(config).filter((r) => {
      const gone = [r.from, r.to].map(remoteAgent).find((a) => a && !known.has(a.node))
      if (gone) this.dropped.push(`Org relation ${r.type} from "${r.from}" to "${r.to}" left out: "${gone.node}" is not a peer in mesh.peers`)
      return !gone
    })
    const problem = relationsProblem(this.relationList, new Set(this.employees.keys()), new Set(people.map((p) => p.id)), known)
    if (problem) throw new Error(problem)
    for (const r of this.relationList) {
      if (r.type === "reports-to") this.bosses.set(r.from, r.to)
    }
    for (const emp of this.employees.values()) {
      const boss = this.reportsTo(emp.agentId)
      if (boss) emp.reportsTo = boss
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

  /** Take the chart from `config` in place, so every part of the business
   *  layer that holds this object sees it at once (#1420). Throws, keeping
   *  the old chart, when `config` is invalid. */
  replaceWith(config: BusinessConfig, people: ReadonlyArray<{ id: string }> = [], peers: ReadonlyArray<string> = []): void {
    Object.assign(this, new Organization(config, people, peers))
  }

  get(agentId: string): EmployeeProfile | undefined {
    return this.employees.get(agentId)
  }

  all(): EmployeeProfile[] {
    return [...this.employees.values()]
  }

  /** Every relation, reportsTo included, with both ends written in full. */
  relations(): OrgRelation[] {
    return [...this.relationList]
  }

  /** The member's reports-to boss: a bare id for an agent here, `person:<id>`
   *  for a person, `agent:<node>/<id>` for an agent on another node. */
  reportsTo(member: string): string | undefined {
    const boss = this.bosses.get(memberKey(member))
    if (!boss) return undefined
    const m = parseMember(boss)
    return m.kind === "agent" && !remoteAgent(boss) ? m.id : boss
  }

  /** A member for people to read: an agent's id, or a person's name. */
  memberLabel(member: string): string {
    return memberLabel(member, this.people)
  }

  /** The agents whose reports-to boss is `member`. */
  directReports(member: string): string[] {
    const key = memberKey(member)
    return [...this.employees.keys()].filter((id) => this.bosses.get(`agent:${id}`) === key)
  }

  /** Walk up reports-to to the root. First element is `agentId` itself.
   *  Agents here only: the walk stops before a person, who is never
   *  dispatched to, and before an agent on another node, who is shown on
   *  the chart but not routed to. */
  chainOfCommand(agentId: string): string[] {
    const chain: string[] = []
    let cur: string | undefined = agentId
    while (cur && !chain.includes(cur)) {
      chain.push(cur)
      const boss = this.bosses.get(`agent:${cur}`)
      cur = boss?.startsWith("agent:") && !remoteAgent(boss) ? parseMember(boss).id : undefined
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
