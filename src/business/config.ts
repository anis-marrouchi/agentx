import { z } from "zod"

// --- Business layer configuration schema ---
// Optional top-level `business` key in agentx.json.
// When enabled, AgentX simulates a team with roles, schedules, and a work pool.

const dayEnum = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])

const scheduleSchema = z.object({
  days: z.array(dayEnum).default(["mon", "tue", "wed", "thu", "fri"]),
  start: z.string().regex(/^\d{2}:\d{2}$/),      // "09:00"
  end: z.string().regex(/^\d{2}:\d{2}$/),        // "17:00"
  lunch: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }).optional(),
})

const roleSchema = z.object({
  title: z.string(),
  responsibilities: z.array(z.string()).default([]),
  sopPath: z.string().optional(),
  kpis: z.array(z.string()).default([]),
})

const orgEntrySchema = z.object({
  role: z.string(),
  reportsTo: z.string().optional(),
  schedule: scheduleSchema,
  utilizationTarget: z.number().min(0).max(1).default(0.8),
})

const channelRefSchema = z.object({
  channel: z.string(),
  chatId: z.string(),
  accountId: z.string().optional(),
})

const workSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("backlog"),
    path: z.string().default(".agentx/backlog.md"),
  }),
  z.object({
    type: z.literal("gitlab"),
    projects: z.array(z.string()).default([]),   // empty = all configured gitlab projects
  }),
  z.object({
    type: z.literal("wiki"),
    path: z.string(),
    glob: z.string().default("**/*.md"),
  }),
])

export const businessConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().default("UTC"),
  mainChannel: channelRefSchema,
  workSource: workSourceSchema,
  roles: z.record(z.string(), roleSchema).default({}),
  orgChart: z.record(z.string(), orgEntrySchema).default({}),
  /** Work-tick cadence in minutes during business hours. Default 15. */
  workTickMinutes: z.number().int().min(1).max(60).default(15),
  /** Max queue depth for an idle agent before skipping the work tick (avoids piling up). */
  idleQueueThreshold: z.number().int().min(0).default(0),
})

export type BusinessConfig = z.infer<typeof businessConfigSchema>
export type BusinessRole = z.infer<typeof roleSchema>
export type BusinessOrgEntry = z.infer<typeof orgEntrySchema>
export type BusinessSchedule = z.infer<typeof scheduleSchema>
export type BusinessWorkSource = z.infer<typeof workSourceSchema>
export type BusinessChannelRef = z.infer<typeof channelRefSchema>
