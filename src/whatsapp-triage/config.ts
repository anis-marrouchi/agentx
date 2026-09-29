import { z } from "zod"

// --- WhatsApp inbound triage settings (agentx.json → whatsappTriage) ---
//
// wacli posts each new WhatsApp message to POST /webhook/wacli. A watch
// rule picks the messages an agent should look at; everything else is
// dropped without being stored. Nothing is ever sent to the contact
// unless the owner approves it (see drafts.ts).

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour")

export const watchRuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "lowercase letters, digits, - and _"),
  enabled: z.boolean().default(true),
  /** Chats to watch: a contact's or a group's JID, or a phone number. */
  chats: z.array(z.string().min(1)).default([]),
  /** Only messages from these people (JID or phone number), in any chat
   *  the rule covers. Empty: anyone. */
  senders: z.array(z.string().min(1)).default([]),
  /** The agent that triages the messages. */
  agent: z.string().min(1),
  /** Extra instructions for the agent: who this contact is, where issues
   *  go, the tone of a reply. */
  prompt: z.string().max(4000).optional(),
  /** No notifications between these times. Triage and drafts still happen. */
  quietHours: z.object({ start: hhmm, end: hhmm }).optional(),
  /** Send the agent's short acknowledgement without asking. Needs
   *  whatsappTriage.allowAutoAck too. */
  autoAck: z.boolean().default(false),
}).refine((r) => r.chats.length > 0 || r.senders.length > 0, {
  message: "a rule needs at least one chat or sender",
})

export const whatsappTriageSchema = z.object({
  enabled: z.boolean().default(false),
  /** Environment variable holding the webhook secret given to
   *  `wacli sync --webhook-secret`. Unsigned requests are refused. */
  secretEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default("WACLI_WEBHOOK_SECRET"),
  /** Messages from one chat within this many seconds become one task. */
  batchSeconds: z.number().int().min(0).max(600).default(20),
  /** Time zone for quiet hours. Default: this computer's. */
  timezone: z.string().optional(),
  /** Second switch for rules with autoAck. Both must be on. */
  allowAutoAck: z.boolean().default(false),
  /** Download images and voice notes so the agent can read or hear them. */
  describeMedia: z.boolean().default(true),
  wacli: z.object({
    bin: z.string().default("wacli"),
    /** `wacli --account NAME`, when more than one is paired. */
    account: z.string().optional(),
    /** `wacli --store DIR`. */
    store: z.string().optional(),
  }).default({}),
  rules: z.array(watchRuleSchema).default([]),
}).default({})

export type WatchRule = z.infer<typeof watchRuleSchema>
export type WhatsappTriageConfig = z.infer<typeof whatsappTriageSchema>
export type WacliSettings = WhatsappTriageConfig["wacli"]
