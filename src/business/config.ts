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

/** Per-project metadata. Phase 3 of the architectural rescue —
 *  `pm` is the agentId responsible for gating dispatches on this
 *  project. Optional; when null, dispatches don't go through a PM
 *  gate. The wiring lives in `decideAndCommit` (gated by a flag,
 *  separate commit). */
const projectSchema = z.object({
  /** Project identifier. For GitLab/GitHub: "owner/repo". For
   *  noqta-internal projects: a stable string. */
  id: z.string(),
  /** AgentId of the PM for this project. Looked up by
   *  `Organization.pmFor(project)` at dispatch time. */
  pm: z.string().optional(),
  /** Optional client this project belongs to. Used by the activity
   *  graph to attribute non-projected events (Telegram chats, free-
   *  text WhatsApp, cron jobs) to the right client. Falls back to
   *  the leading segment of `id` (split on "/") when unset. */
  client: z.string().optional(),
})

/** Maps a chat or sender to a client/project so free-text channels
 *  (telegram/whatsapp/slack/discord/email) get attributed correctly
 *  in the activity graph. Without this, every chat lands in the
 *  fallback "internal" bucket — the operator can't tell which client
 *  the agent was helping.
 *
 *  Match priority: chatId > username > channel-default. First match
 *  wins. All fields except `client` are optional; `project` falls
 *  back to `${client}/_chat` when unset. */
const contactMapSchema = z.object({
  /** Channel kind, e.g. "telegram", "whatsapp", "slack", "discord". */
  channel: z.string().optional(),
  /** Native chat id ("-100..." for tg groups, JID for WhatsApp). */
  chatId: z.string().optional(),
  /** Sender username/handle as exposed by the channel adapter. */
  username: z.string().optional(),
  /** Numeric sender id when username is unstable. */
  senderId: z.string().optional(),
  /** Client this contact belongs to. Required. */
  client: z.string(),
  /** Project this contact's traffic should attribute to. Defaults to
   *  `${client}/_chat`. */
  project: z.string().optional(),
  /** Display name override for the initiator pill. */
  displayName: z.string().optional(),
})

export const businessConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timezone: z.string().default("UTC"),
  mainChannel: channelRefSchema,
  workSource: workSourceSchema,
  roles: z.record(z.string(), roleSchema).default({}),
  orgChart: z.record(z.string(), orgEntrySchema).default({}),
  /** Per-project metadata. Phase 3 — defaults to empty array, so
   *  existing agentx.json files validate without modification. */
  projects: z.array(projectSchema).default([]),
  /** Maps free-text chat senders to a client/project so the activity
   *  graph can attribute Telegram/WhatsApp/etc. to the right client
   *  instead of the catch-all "internal" bucket. */
  contactMap: z.array(contactMapSchema).default([]),
  /** Work-tick cadence in minutes during business hours. Default 15. */
  workTickMinutes: z.number().int().min(1).max(60).default(15),
  /** Max queue depth for an idle agent before skipping the work tick (avoids piling up). */
  idleQueueThreshold: z.number().int().min(0).default(0),
  /** Standup-tick gating + plan-driven priorities. The day-cycle's morning
   *  STANDUP used to fire unconditionally per agent — operators reported it
   *  as "mechanical" because it dispatched a Claude turn even when no human
   *  had set a plan for the day. Now: the cycle reads
   *  .agentx/plans/<date>.md (day → week → month fallback) and either
   *  injects the plan as standup priorities, or posts a "no plan today"
   *  notification to mainChannel and dispatches no agent. */
  standup: z.object({
    /** Master switch. When false, fireStandup is a no-op (silent). */
    enabled: z.boolean().default(true),
    /** Plans directory, relative to the daemon CWD. */
    plansDir: z.string().default(".agentx/plans"),
    /** Hard ceiling on how many agents the standup tick can dispatch in a
     *  single morning — guards against an org-chart misconfiguration
     *  fanning out to dozens of Claude calls before anyone notices. */
    maxAgentsPerDay: z.number().int().min(1).max(100).default(20),
    /** When true, even with a plan present the cycle won't dispatch — only
     *  posts the resolved plan to mainChannel for human review. Useful as
     *  a kill-switch while iterating on plan formats. */
    dryRun: z.boolean().default(false),
  }).default({}),
})

export type BusinessConfig = z.infer<typeof businessConfigSchema>
export type BusinessRole = z.infer<typeof roleSchema>
export type BusinessOrgEntry = z.infer<typeof orgEntrySchema>
export type BusinessSchedule = z.infer<typeof scheduleSchema>
export type BusinessWorkSource = z.infer<typeof workSourceSchema>
export type BusinessChannelRef = z.infer<typeof channelRefSchema>
export type BusinessProject = z.infer<typeof projectSchema>
