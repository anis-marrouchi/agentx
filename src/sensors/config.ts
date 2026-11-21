import { z } from "zod"
import { cronValueSchema } from "@/crons/value-line"
import { GOAL_ID_MAX } from "@/requests/goals"
import { batteryReaderMissing } from "@/native/battery-reader"

// --- sensors: settings (#863) ---
//
//   sensors:
//     battery:                      # battery-watch.sh, line for line
//       reading: battery            # the only built-in reader so far
//       every: "60s"                # how often it is read, 20s or more
//       levels:
//         - { id: on-30min, when: { forMinutes: 30 }, target: coo-agent, brief: "DevOps battery watch" }
//         - { id: below-50, when: { below: 50 }, target: coo-agent, brief: "DevOps battery watch" }
//         - { id: below-25, when: { below: 25 }, urgent: true, push: { from: DevOps, key: mac-battery-low } }
//         - { id: below-15, when: { below: 15 }, target: coo-agent, brief: "DevOps battery watch, URGENT", fallbackPush: true }
//       rearm: { above: 30, onAC: true }
//       value: { why: "...", metric: "..." }
//       goal: mac-health
//
// macOS only (pmset): the config check refuses a battery sensor elsewhere.
// A reading costs no model. A level whose condition holds wakes its target
// agent once per battery stretch, always at priority critical, or with
// `urgent` sends the model-free push `agentx notify --urgent` sends. Only a
// `fallbackPush` level sends that push when its wake has not started within
// 2 minutes, or failed; any other held wake gets a Wall line and a retry.
// See src/sensors/levels.ts. State: .agentx/state/sensors.json.

export const SENSOR_EVERY_MIN_MS = 20_000
const EVERY = /^(\d+)\s*(s|m)$/

/** "60s" or "5m" in ms; null when it is not one of those. */
export function everyMs(every: string): number | null {
  const m = EVERY.exec(every.trim())
  if (!m) return null
  return Number(m[1]) * (m[2] === "m" ? 60_000 : 1000)
}

const levelSchema = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[a-z0-9][\w.:-]*$/i, "a level id is letters, digits, dashes, dots or colons"),
  when: z.object({
    /** A level is a battery-stretch condition: only `true` is accepted. */
    onBattery: z.literal(true).default(true),
    /** Holds once the stretch on battery is this many minutes long. */
    forMinutes: z.number().int().min(1).max(24 * 60).optional(),
    /** Holds while the charge is under this percentage. */
    below: z.number().int().min(1).max(100).optional(),
  }).refine((w) => w.forMinutes !== undefined || w.below !== undefined, "a level needs forMinutes or below"),
  /** The agent woken (an agent of this node). Required unless `urgent`. */
  target: z.string().trim().min(1).optional(),
  /** A model-free push to the owner instead of a wake. */
  urgent: z.boolean().default(false),
  /** The wake falls back to the model-free push when it has not started
   *  within 2 minutes, or failed (the script's 15 % line only). Other agent
   *  levels get a Wall line and a retry, never a push to the operator. */
  fallbackPush: z.boolean().default(false),
  /** Words put before the wake's text, e.g. who is speaking. */
  brief: z.string().trim().min(1).max(200).optional(),
  /** How the push reads, for `urgent` and for a `fallbackPush` level. */
  push: z.object({
    title: z.string().trim().min(1).max(60).default("Mac battery low"),
    from: z.string().trim().min(1).max(60).default("agentx"),
    key: z.string().trim().min(1).max(120).optional(),
    todo: z.string().trim().min(1).max(120).default("plug in the charger"),
    priority: z.number().int().min(1).max(5).default(5),
  }).default({}),
}).superRefine((l, ctx) => {
  if (!l.urgent && !l.target) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a level needs a target agent, or urgent: true", path: ["target"] })
  if (l.urgent && l.target) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "an urgent level is a push to the owner: leave target out", path: ["target"] })
  if (l.urgent && l.fallbackPush) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fallbackPush is for a level that wakes an agent; an urgent level already is the push", path: ["fallbackPush"] })
})

export const sensorSchema = z.object({
  reading: z.literal("battery"),
  every: z.string().default("60s").superRefine((v, ctx) => {
    const ms = everyMs(v)
    if (ms === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'every is a number of seconds or minutes, e.g. "60s" or "5m"' })
    else if (ms < SENSOR_EVERY_MIN_MS) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "every is 20s or more" })
  }),
  levels: z.array(levelSchema).min(1).superRefine((levels, ctx) => {
    const seen = new Set<string>()
    for (const [i, l] of levels.entries()) {
      if (seen.has(l.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `level id "${l.id}" is used twice`, path: [i, "id"] })
      seen.add(l.id)
    }
  }),
  /** When an urgent level may push again: on AC (when onAC) above this %. */
  rearm: z.object({
    above: z.number().int().min(1).max(100).default(30),
    onAC: z.boolean().default(true),
  }).default({}),
  /** Why it runs and the number that proves it, as on a cron job (#1183). */
  value: cronValueSchema.optional(),
  /** The goal record it serves (#1568), by id. */
  goal: z.string().trim().min(1).max(GOAL_ID_MAX).regex(/^[a-z0-9][\w.:-]*$/i, "goal must be a goal id: letters, digits, dashes, dots or colons").optional(),
})

export const sensorsConfigSchema = z.record(
  z.string().regex(/^[a-z0-9][\w.-]*$/i, "a sensor id is letters, digits, dashes or dots"),
  sensorSchema,
).default({})

export type SensorConfig = z.infer<typeof sensorSchema>
export type SensorLevel = SensorConfig["levels"][number]
export type SensorsConfig = z.infer<typeof sensorsConfigSchema>

/** What the config check refuses across fields: a battery sensor on a node
 *  that is not macOS (`pmset` is macOS only), a target that is no agent
 *  of this node. `platform` is injectable for tests. */
export function sensorProblems(
  cfg: { sensors?: SensorsConfig; agents?: Record<string, unknown> },
  platform: NodeJS.Platform = process.platform,
): string[] {
  const problems: string[] = []
  for (const [id, s] of Object.entries(cfg.sensors ?? {})) {
    const missing = s.reading === "battery" ? batteryReaderMissing(platform) : null
    if (missing) problems.push(`sensors.${id}: ${missing}. Remove it from this node's config.`)
    for (const l of s.levels) {
      if (l.target && cfg.agents && !(l.target in cfg.agents)) {
        problems.push(`sensors.${id}.levels.${l.id}.target: "${l.target}" is no agent of this node.`)
      }
    }
  }
  return problems
}
