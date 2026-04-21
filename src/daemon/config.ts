import { z } from "zod"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { businessConfigSchema } from "@/business/config"
import { boardsConfigSchema, dashboardConfigSchema } from "@/boards/config"

/**
 * Load .env file into process.env (simple, no dependency).
 */
function loadDotEnv(dir: string): void {
  const envPath = resolve(dir, ".env")
  if (!existsSync(envPath)) return

  const content = readFileSync(envPath, "utf-8")
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const value = trimmed.slice(eqIdx + 1).trim()
    if (!process.env[key]) {
      process.env[key] = value
    }
  }
}

// --- Daemon configuration schema & loader ---

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  baseUrl: z.string().optional(),
})

const agentConfigSchema = z.object({
  name: z.string(),
  workspace: z.string(),
  tier: z.enum(["claude-code", "sdk", "orchestrator"]).default("claude-code"),
  provider: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  mentions: z.array(z.string()).default([]),
  maxConcurrent: z.number().default(1),
  /** Hard wall-clock cap on a single Claude Code invocation. Exceeding the
   *  cap sends SIGTERM (exit 143). Default 20 min — bump for devops/coder
   *  agents that do long investigations or multi-file refactors. */
  maxExecutionMinutes: z.number().int().min(1).max(240).default(20),
  permissionMode: z.string().default("default"),
  queueMode: z.enum(["collect", "followup", "drop"]).default("collect"),
  heartbeat: z.object({
    enabled: z.boolean().default(false),
    intervalMinutes: z.number().default(30),
    prompt: z.string().default("Check inbox, pending tasks, and system health. Report anything that needs attention."),
    channel: z.string().default("heartbeat"),
  }).default({}),
  /** Reachability via the external public API.
   *   - "private" (default): this agent is daemon-internal + channel-bound only.
   *   - "public": external apps can POST /api/public/agents/<id>/messages
   *     with a scoped token (agent:<id> or agent:*). */
  access: z.enum(["private", "public"]).default("private"),
})

const telegramAccountSchema = z.object({
  token: z.string(),
  agentBinding: z.string(),
  /** Per-account sender allowlist. When set, OVERRIDES the global
   *  `policy.allowFrom`. Entries accept:
   *    - numeric user id  ("1816212449")         — matches sender (from.id)
   *    - numeric chat id  ("-1003861455814")     — matches chat (chat.id)
   *    - "@username"                             — matches sender username
   *  A message is dispatched iff at least one entry matches. */
  allowFrom: z.array(z.string()).optional(),
})

const channelsConfigSchema = z.object({
  telegram: z.object({
    enabled: z.boolean().default(false),
    accounts: z.record(z.string(), telegramAccountSchema).default({}),
    policy: z.object({
      dm: z.enum(["pair", "block"]).default("pair"),
      group: z.enum(["mention-required", "all"]).default("mention-required"),
      /** Global sender allowlist applied to every account that doesn't set
       *  its own `allowFrom`. When neither is configured, every incoming
       *  message is dropped — closed by default. Same entry forms as the
       *  per-account list (user id, chat id, @username). */
      allowFrom: z.array(z.string()).optional(),
    }).default({}),
  }).default({}),
  whatsapp: z.object({
    enabled: z.boolean().default(false),
    sessionDir: z.string().default(".agentx/whatsapp-sessions"),
    defaultAgent: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    routes: z.array(z.object({
      contact: z.string().optional(),
      group: z.string().optional(),
      agent: z.string(),
    })).default([]),
    /** Data-source ingestion — turns WhatsApp from a messaging-only channel
     *  into a source that seeds the wiki with contact/group metadata (and
     *  optionally bounded message windows) per an explicit allowlist.
     *  Default-deny: `enabled: false` and empty allowlists mean nothing is
     *  ingested. See docs/reference/whatsapp-ingest.md for the full story. */
    ingest: z.object({
      enabled: z.boolean().default(false),
      /** `metadata-only` pulls contact/group info; `messages` additionally
       *  pulls the last `messageCap` messages per allowlisted chat. */
      mode: z.enum(["metadata-only", "messages"]).default("metadata-only"),
      /** Phone numbers or JIDs. Substring match, same semantics as allowFrom. */
      allowContacts: z.array(z.string()).default([]),
      allowGroups: z.array(z.string()).default([]),
      denyContacts: z.array(z.string()).default([]),
      denyGroups: z.array(z.string()).default([]),
      /** Per-chat cap when mode = "messages". Keeps the raw-entry size bounded. */
      messageCap: z.number().int().min(1).max(500).default(50),
      /** Max age (days) of messages to consider for the bounded window. */
      historyDays: z.number().int().min(1).max(365).default(30),
      /** Skip re-writing a contact entry unless this many days have passed
       *  OR the profile hash differs. Prevents churn on unchanged profiles. */
      contactRefreshDays: z.number().int().min(1).max(90).default(7),
      /** Safety rails on live Baileys reads — personal-account accounts
       *  can get throttled/banned under burst reads. */
      throttle: z.object({
        minMsBetweenCalls: z.number().int().min(100).default(1500),
        maxCallsPerMinute: z.number().int().min(1).default(20),
        maxChatsPerSweep: z.number().int().min(1).default(25),
      }).default({}),
      /** Purge absorbed raw entries older than this many days. `0` = never. */
      retentionDays: z.number().int().min(0).default(0),
    }).default({}),
  }).default({}),
  discord: z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),
    agentBinding: z.string().optional(),
  }).default({}),
  slack: z.object({
    enabled: z.boolean().default(false),
    /** xoxb-... — bot user OAuth token from the Slack app's "OAuth & Permissions" tab. */
    botToken: z.string().optional(),
    /** xapp-... — app-level token with connections:write scope (for Socket Mode). */
    appToken: z.string().optional(),
    agentBinding: z.string().optional(),
  }).default({}),
  gitlab: z.object({
    enabled: z.boolean().default(false),
    webhookPort: z.number().default(18810),
    webhookSecret: z.string().optional(),
    host: z.string().default("https://gitlab.com"),
    token: z.string().optional(),
    routes: z.array(z.object({
      project: z.string(),
      agent: z.string(),
    })).default([]),
    agentMappings: z.array(z.object({
      agentId: z.string(),
      gitlabUsernames: z.array(z.string()).default([]),
      keywords: z.array(z.string()).default([]),
      token: z.string().optional(),
      /** If set, the agent lives on a remote mesh peer (node id). Forces the
       *  username→agent map to resolve to this mapping even when a local
       *  agent's token resolves to the same GitLab user — prevents collisions
       *  like two agents both claiming @devops-noqta. */
      node: z.string().optional(),
    })).default([]),
  }).default({}),
})

const cronJobSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string(),
  timezone: z.string().default("UTC"),
  agent: z.string(),
  prompt: z.string(),
  timeout: z.number().default(600),
  model: z.string().optional(),
  /** Soft cap on output length. Claude Code CLI has no hard flag for this,
   *  but appending an instruction to the prompt is reliably honored. Use
   *  1500 for briefs, 500 for status pings, 300 for pure classifiers. */
  maxOutputTokens: z.number().int().min(50).max(8000).optional(),
  onError: z.union([
    z.enum(["log", "notify", "disable"]),
    z.array(z.enum(["log", "notify", "disable"])),
  ]).default("log").transform(v => Array.isArray(v) ? v : [v]),
  notify: z.object({
    channel: z.string(),
    chatId: z.string(),
    accountId: z.string().optional(),
  }).optional(),
})

const serviceSchema = z.object({
  name: z.string(),
  triggers: z.array(z.object({
    pattern: z.string(),
    channel: z.string().optional(),
  })),
  allowedContacts: z.array(z.string()).optional(),
  agent: z.string(),
  prompt: z.string(),
  schedule: z.string().optional(),
  timezone: z.string().default("UTC"),
  notify: z.object({
    channel: z.string(),
    chatId: z.string(),
    accountId: z.string().optional(),
  }).optional(),
})

const meshPeerSchema = z.object({
  url: z.string(),
  name: z.string(),
  token: z.string().optional(),
})

const meshConfigSchema = z.object({
  enabled: z.boolean().default(false),
  peers: z.array(meshPeerSchema).default([]),
  discovery: z.enum(["static", "mdns"]).default("static"),
  healthCheck: z.object({
    interval: z.number().default(60),
    timeout: z.number().default(10),
  }).default({}),
})

/** Intent Knowledge Graph — fixed-axis, LLM-proposed taxonomy used by the
 *  Intent layer in context.ts and (eventually) wiki retrieval. Off by default
 *  so existing installs see no change. */
const graphConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Where the schema/nodes/classifications live. Relative to cwd. */
  baseDir: z.string().default(".agentx/graph"),
  /** Which agent makes LLM classification proposals. Falls back to
   *  `dashboard.draftAgent` at call sites if unset. */
  draftAgent: z.string().optional(),
  /** Agent used by `agentx graph review` to triage pending classifications.
   *  Should be an agent with the wiki skill so it can call `wiki query` for
   *  context before deciding approve/reject. Falls back to draftAgent. */
  reviewAgent: z.string().optional(),
  /** Structural auto-approval policy. Evaluated against each classification
   *  independently of `autoApproveConfidence`; either triggers approval.
   *    - "strict"        : never approve via structure — every classification
   *                        waits for human review
   *    - "extend-leaves" : auto-approve when the proposed path (a) reuses only
   *                        existing nodes, or (b) adds exactly one NEW node at
   *                        the deepest level. Structural changes (new mid-path
   *                        node, new root) still queue for review. Default.
   *    - "any"           : auto-approve every classification regardless of
   *                        structural change
   */
  autoApproveStructure: z.enum(["strict", "extend-leaves", "any"]).default("extend-leaves"),
  /** Minimum classifier confidence (0..1) to auto-approve. OR'd with the
   *  structural policy — either hitting the threshold lets the classification
   *  bypass the pending queue. 1.0 (default) disables this knob, so approval
   *  is driven by `autoApproveStructure` alone. Lower it to e.g. 0.7 if you
   *  also want high-confidence structural changes auto-approved. */
  autoApproveConfidence: z.number().min(0).max(1).default(1.0),
  /** Weights for the wiki hybrid retrieval score. Path-ancestry match vs
   *  BM25 over article text. Sum need not be 1. */
  retrievalWeights: z.object({
    graph: z.number().min(0).default(0.6),
    bm25: z.number().min(0).default(0.4),
  }).default({}),
}).default({})

const notificationsSchema = z.object({
  /** Send notification when task takes longer than this (seconds). 0 = disabled. */
  longTaskThreshold: z.number().default(30),
  /** Where to send notifications */
  destination: z.object({
    channel: z.string(),
    chatId: z.string(),
    accountId: z.string().optional(),
  }).optional(),
  /** Notify on these events */
  on: z.object({
    taskComplete: z.boolean().default(true),
    taskError: z.boolean().default(true),
    taskQueued: z.boolean().default(false),
  }).default({}),
}).default({})

export const daemonConfigSchema = z.object({
  node: z.object({
    id: z.string(),
    name: z.string(),
    bind: z.string().default("127.0.0.1:18800"),
    /** Default agent for voice/API calls that don't specify one (e.g. Siri) */
    defaultAgent: z.string().optional(),
  }),
  providers: z.record(z.string(), providerConfigSchema).default({}),
  agents: z.record(z.string(), agentConfigSchema).default({}),
  channels: channelsConfigSchema.default({}),
  crons: z.record(z.string(), cronJobSchema).default({}),
  services: z.record(z.string(), serviceSchema).default({}),
  notifications: notificationsSchema,
  mesh: meshConfigSchema.default({}),
  business: businessConfigSchema.optional(),
  boards: boardsConfigSchema,
  dashboard: dashboardConfigSchema,
  graph: graphConfigSchema,
  /** Registered inbound webhooks — an inventory the dashboard manages. Each
   *  entry binds an (agent, source) pair to an optional signing secret. The
   *  actual inbound URL is always POST /webhook/<agentId>/<source>. */
  webhooks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "webhook id must be lowercase slug"),
    source: z.enum(["gitlab", "github", "sentry", "stripe", "discord", "slack", "custom"]),
    agentId: z.string(),
    secretEnv: z.string().optional(),
    description: z.string().optional(),
    enabled: z.boolean().default(true),
    /** Route to a mesh peer instead of local execution. */
    node: z.string().optional(),
  })).default([]),
  /** Session cache-reuse policy. Controls when we drop a Claude `--resume`
   *  session and rebuild the prompt from scratch.
   *  - `staleMinutes`: idle timeout before rotation. Longer is cheaper at
   *    Opus rates but lets a session accumulate tool-result bloat across an
   *    all-day chat.
   *  - `maxTurnsPerSession`: hard cap on turns per Claude session. Prevents
   *    unbounded `--resume` growth. When hit, next turn starts fresh with
   *    the compacted summary + recent-messages context.
   *  - `tierTwoThresholdTokens`: if the prior turn's (input + cacheRead +
   *    cacheCreate) exceeded this, rotate proactively. Claude bills tier-2
   *    at 1.5× above 200K total input, so rotating before that threshold
   *    undercuts the multiplier. */
  session: z.object({
    staleMinutes: z.number().int().min(1).max(1440).default(45),
    maxTurnsPerSession: z.number().int().min(2).max(200).default(15),
    tierTwoThresholdTokens: z.number().int().min(50_000).max(200_000).default(180_000),
    /** Context assembly strategy:
     *  - "layered" (default): the classic stacked layers — session history,
     *    memory, cross-chat, wiki hint all appended every turn.
     *  - "planner": a Haiku pre-call decides what to retrieve before the
     *    main agent runs. Always-on core is kept (channel/scope/landscape/
     *    identity/intent + last 3 turns verbatim); history blob, wiki hint,
     *    and cross-chat are replaced by planner-selected bundles. Per-task
     *    overrides via AgentTask.contextStrategy for A/B benchmarking. */
    contextStrategy: z.enum(["layered", "planner"]).default("layered"),
  }).default({}),
})

export type DaemonConfig = z.infer<typeof daemonConfigSchema>
export type AgentDef = z.infer<typeof agentConfigSchema>
export type CronJobDef = z.infer<typeof cronJobSchema>
export type MeshPeer = z.infer<typeof meshPeerSchema>

/**
 * Expand environment variables in strings: ${VAR_NAME} -> process.env.VAR_NAME
 */
export function expandEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (_match, name) => process.env[name] || "")
  }
  if (Array.isArray(obj)) {
    return obj.map(expandEnvVars)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = expandEnvVars(value)
    }
    return result
  }
  return obj
}

/**
 * Load daemon config from agentx.json, with env var expansion and validation.
 */
export function loadDaemonConfig(configPath?: string): DaemonConfig {
  const paths = configPath
    ? [configPath]
    : [
        resolve(process.cwd(), "agentx.json"),
        resolve(process.cwd(), ".agentx/config.json"),
      ]

  // Load .env from same directory as config search
  loadDotEnv(process.cwd())

  let raw: string | undefined
  let foundPath: string | undefined

  for (const p of paths) {
    if (existsSync(p)) {
      raw = readFileSync(p, "utf-8")
      foundPath = p
      break
    }
  }

  if (!raw || !foundPath) {
    throw new Error(
      `No config found. Create agentx.json or .agentx/config.json\n` +
        `Searched: ${paths.join(", ")}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Invalid JSON in ${foundPath}: ${e.message}`)
  }

  // Expand environment variables
  const expanded = expandEnvVars(parsed)

  // Validate
  const result = daemonConfigSchema.safeParse(expanded)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Config validation failed (${foundPath}):\n${issues}`)
  }

  return result.data
}

/**
 * Validate agent workspace directories exist and have .claude/ setup.
 */
export function validateWorkspaces(config: DaemonConfig): string[] {
  const warnings: string[] = []

  for (const [id, agent] of Object.entries(config.agents)) {
    if (!existsSync(agent.workspace)) {
      warnings.push(`Agent "${id}": workspace not found at ${agent.workspace}`)
      continue
    }

    if (agent.tier === "claude-code") {
      const claudeDir = resolve(agent.workspace, ".claude")
      if (!existsSync(claudeDir)) {
        warnings.push(
          `Agent "${id}": no .claude/ directory in workspace ${agent.workspace}. ` +
            `Claude Code native features (hooks, MCP, skills) won't be available.`
        )
      }
    }

    // Check provider availability
    const providerName = agent.provider || "claude"
    const providerConfig = config.providers[providerName]
    if (agent.tier !== "claude-code" && (!providerConfig || !providerConfig.apiKey)) {
      warnings.push(
        `Agent "${id}": provider "${providerName}" has no API key configured. ` +
          `Set providers.${providerName}.apiKey in config or use tier "claude-code" for subscription.`
      )
    }
  }

  // Validate cron agent bindings
  for (const [id, cron] of Object.entries(config.crons)) {
    if (!config.agents[cron.agent]) {
      warnings.push(`Cron "${id}": references unknown agent "${cron.agent}"`)
    }
  }

  // Validate channel agent bindings
  if (config.channels.telegram.enabled) {
    for (const [name, account] of Object.entries(config.channels.telegram.accounts)) {
      if (!config.agents[account.agentBinding]) {
        warnings.push(
          `Telegram account "${name}": references unknown agent "${account.agentBinding}"`
        )
      }
    }
  }

  return warnings
}
