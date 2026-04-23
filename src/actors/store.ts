import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { resolve } from "path"
import {
  actorSchema,
  roleSchema,
  type Actor,
  type ActorChannel,
  type Role,
  type AssigneeRef,
} from "./types"

// --- Actor / Role filesystem store ---
//
// Two sibling directories under .agentx/:
//   actors/<actor-id>.json
//   roles/<role-id>.json
//
// The store exposes CRUD + two resolution helpers needed by the workflow
// engine:
//   resolveMembers(assignee)  — role or actor ref → flat actor id list
//                               (handles nested roles, strategy picks who sees
//                               the task)
//   channelFor(actorId, ch)   — actor id + preferred channel → handle string

export interface ActorStoreOptions {
  baseDir?: string
}

export class ActorStore {
  readonly actorsDir: string
  readonly rolesDir: string

  constructor(opts: ActorStoreOptions = {}) {
    const root = opts.baseDir ?? resolve(process.cwd(), ".agentx")
    this.actorsDir = resolve(root, "actors")
    this.rolesDir = resolve(root, "roles")
    mkdirSync(this.actorsDir, { recursive: true })
    mkdirSync(this.rolesDir, { recursive: true })
  }

  // --- Actors ---

  private actorPath(id: string): string {
    const safe = id.replace(/^actor:/, "")
    return resolve(this.actorsDir, `${safe}.json`)
  }

  listActors(): Actor[] {
    if (!existsSync(this.actorsDir)) return []
    const out: Actor[] = []
    for (const entry of readdirSync(this.actorsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(this.actorsDir, entry.name), "utf-8"))
        const parsed = actorSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data)
      } catch {
        // skip malformed
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  getActor(id: string): Actor | null {
    const full = this.actorPath(id)
    if (!existsSync(full)) return null
    try {
      const raw = JSON.parse(readFileSync(full, "utf-8"))
      const parsed = actorSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  saveActor(actor: Actor): Actor {
    const parsed = actorSchema.parse({
      ...actor,
      created: actor.created ?? new Date().toISOString(),
      updated: new Date().toISOString(),
    })
    writeFileSync(this.actorPath(parsed.id), JSON.stringify(parsed, null, 2))
    return parsed
  }

  deleteActor(id: string): boolean {
    const full = this.actorPath(id)
    if (!existsSync(full)) return false
    unlinkSync(full)
    return true
  }

  // --- Roles ---

  private rolePath(id: string): string {
    const safe = id.replace(/^role:/, "")
    return resolve(this.rolesDir, `${safe}.json`)
  }

  listRoles(): Role[] {
    if (!existsSync(this.rolesDir)) return []
    const out: Role[] = []
    for (const entry of readdirSync(this.rolesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue
      try {
        const raw = JSON.parse(readFileSync(resolve(this.rolesDir, entry.name), "utf-8"))
        const parsed = roleSchema.safeParse(raw)
        if (parsed.success) out.push(parsed.data)
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id))
  }

  getRole(id: string): Role | null {
    const full = this.rolePath(id)
    if (!existsSync(full)) return null
    try {
      const raw = JSON.parse(readFileSync(full, "utf-8"))
      const parsed = roleSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  saveRole(role: Role): Role {
    const parsed = roleSchema.parse({
      ...role,
      created: role.created ?? new Date().toISOString(),
      updated: new Date().toISOString(),
    })
    writeFileSync(this.rolePath(parsed.id), JSON.stringify(parsed, null, 2))
    return parsed
  }

  deleteRole(id: string): boolean {
    const full = this.rolePath(id)
    if (!existsSync(full)) return false
    unlinkSync(full)
    return true
  }

  // --- Resolution ---

  /** Flatten a role (or actor) reference to a concrete list of actor ids.
   *  Handles nested roles (role containing role). Cycles are guarded. */
  resolveMembers(assignee: AssigneeRef): string[] {
    if (assignee.kind === "actor") return [assignee.id]
    const seen = new Set<string>()
    const out: string[] = []
    const walk = (roleId: string) => {
      if (seen.has(roleId)) return
      seen.add(roleId)
      const role = this.getRole(roleId)
      if (!role) return
      for (const member of role.members) {
        if ("actor" in member) {
          if (!out.includes(member.actor)) out.push(member.actor)
        } else {
          walk(member.role)
        }
      }
    }
    walk(assignee.id)
    return out
  }

  /** Pick which members of an assignee actually see a task right now,
   *  obeying the role's assignment strategy. Returns one or more actor ids. */
  pickAssignees(assignee: AssigneeRef): string[] {
    const members = this.resolveMembers(assignee)
    if (members.length === 0) return []
    if (assignee.kind === "actor") return members
    const role = this.getRole(assignee.id)
    if (!role) return members.slice(0, 1)
    switch (role.assignmentStrategy) {
      case "all":
        return members
      case "round-robin": {
        const idx = role.rotationCursor % members.length
        const picked = members[idx]
        this.saveRole({ ...role, rotationCursor: (role.rotationCursor + 1) % Math.max(members.length, 1) })
        return [picked]
      }
      case "first-available":
      case "manager-of":
      default:
        return [members[0]]
    }
  }

  /** Look up an actor's handle for a given channel. Returns null if the
   *  actor has no handle on that channel. */
  channelFor(actorId: string, channel: ActorChannel["channel"]): string | null {
    const actor = this.getActor(actorId)
    if (!actor) return null
    const match = actor.channels.find((c) => c.channel === channel)
    return match?.handle ?? null
  }

  /** Pick the delivery channel for user-task notifications. Prefers the
   *  channel marked preferredForTasks, else the first channel. */
  preferredChannel(actorId: string): ActorChannel | null {
    const actor = this.getActor(actorId)
    if (!actor || actor.channels.length === 0) return null
    return actor.channels.find((c) => c.preferredForTasks) ?? actor.channels[0]
  }
}
