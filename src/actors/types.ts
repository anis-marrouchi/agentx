import { z } from "zod"

// --- Actor + Role primitives ---
//
// An Actor is a human participant in a business activity. They carry one or
// more channel handles (a Telegram user id, a WhatsApp phone, a Slack member
// id, an email address) so the workflow engine can deliver user tasks to
// wherever they actually read messages.
//
// A Role is a named group of Actors (or nested Roles). User tasks may be
// assigned to a Role instead of a specific Actor — the engine uses the Role's
// assignmentStrategy to pick which member(s) actually see the task.
//
// Both are stored as JSON under .agentx/actors/ and .agentx/roles/.

export const actorChannelSchema = z.object({
  channel: z.enum(["telegram", "whatsapp", "slack", "discord", "email"]),
  /** Channel-native handle: telegram user id, phone number (E.164), slack
   *  member id, discord user id, email address. Stable per channel. */
  handle: z.string().min(1),
  /** If true, user-task notifications for this actor land on this channel
   *  first. At most one channel should be marked preferred; ties break in
   *  array order. */
  preferredForTasks: z.boolean().optional(),
})
export type ActorChannel = z.infer<typeof actorChannelSchema>

export const actorSchema = z.object({
  id: z.string().regex(/^actor:[a-z0-9][a-z0-9_-]*$/, "actor id must be 'actor:<slug>'"),
  name: z.string().min(1),
  email: z.string().email().optional(),
  channels: z.array(actorChannelSchema).min(1, "actor must have at least one channel handle"),
  timezone: z.string().optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
})
export type Actor = z.infer<typeof actorSchema>

export const roleMemberSchema = z.union([
  z.object({ actor: z.string() }),
  z.object({ role: z.string() }),
])
export type RoleMember = z.infer<typeof roleMemberSchema>

export const assignmentStrategySchema = z.enum([
  "first-available",  // first member in order
  "round-robin",      // rotate across members (state persisted on the role)
  "all",              // assign to every member simultaneously
  "manager-of",       // resolve via actor.managerOf relationship (future)
])
export type AssignmentStrategy = z.infer<typeof assignmentStrategySchema>

export const roleSchema = z.object({
  id: z.string().regex(/^role:[a-z0-9][a-z0-9_-]*$/, "role id must be 'role:<slug>'"),
  name: z.string().min(1),
  members: z.array(roleMemberSchema).default([]),
  assignmentStrategy: assignmentStrategySchema.default("first-available"),
  /** Mutable rotation cursor for round-robin. Incremented on assign. */
  rotationCursor: z.number().int().default(0),
  created: z.string().optional(),
  updated: z.string().optional(),
})
export type Role = z.infer<typeof roleSchema>

// Reference shape used in workflow node configs: either an actor id or a role
// id. Encoded as a string with the typed prefix so templating stays simple.
export type ActorRef = { kind: "actor"; id: string }
export type RoleRef = { kind: "role"; id: string }
export type AssigneeRef = ActorRef | RoleRef

export function parseAssigneeRef(raw: string): AssigneeRef | null {
  if (raw.startsWith("actor:")) return { kind: "actor", id: raw }
  if (raw.startsWith("role:"))  return { kind: "role",  id: raw }
  return null
}
