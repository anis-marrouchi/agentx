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

const mcpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
})

const agentConfigSchema = z.object({
  name: z.string(),
  workspace: z.string(),
  tier: z.enum(["claude-code", "sdk", "orchestrator"]).default("claude-code"),
  provider: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  mentions: z.array(z.string()).default([]),
  /** Phase 5 — typed capabilities (drop-condition fallback). Free-form
   *  list of intent strings this agent is allowed to handle. When set,
   *  the org-chart `canHandle(agentId, project, intent)` check rejects
   *  dispatches with intents not in this list. When empty/unset
   *  (the default), the agent is permissive — handles any intent.
   *  Intent matching is exact-string for now; a glob/prefix layer can
   *  come later if it produces real rejections.
   *  Example: ["issue.opened", "issue.commented", "merge_request.opened"]
   *  Example: ["cron.fired", "message.received"]              */
  intents: z.array(z.string()).default([]),
  /** Phase 8 — capability-bounded security. Max distinct upstream
   *  agents in the delegation chain on the same (project, subject)
   *  before a dispatch to THIS agent is refused. The ledger itself
   *  provides the chain — `decideAndCommit` walks recent decisions on
   *  the subject and counts distinct agents. Default 5; set to 0 to
   *  disable for an agent that's always called as the bottom of a
   *  chain. The check prevents cascade loops where A → B → A → B → ...
   *  blows past sane chain depth. */
  maxDelegationDepth: z.number().int().min(0).max(50).default(5),
  /** MCP servers this agent's Claude Code session should load. Synced
   *  to <workspace>/.mcp.json at daemon boot via agent-mcp.ts. Operator
   *  edits to .mcp.json are respected (see SyncResult.skipped-operator-owned). */
  mcp: z.record(z.string(), mcpServerSchema).optional(),
  /** Per-agent override for the global `session.contextStrategy`. Lets
   *  one agent run `planner` (smaller upfront context, more tool-driven
   *  exploration) while siblings stay on `layered`. Used for agents that
   *  consistently bloat their cache via large workspace reads. */
  contextStrategy: z.enum(["layered", "planner"]).optional(),
  /** When true, the registry resolves references-recipes for this agent's
   *  workspace and renders a deterministic [Verified References] block at
   *  priority 4.7. Off by default — flip on per agent (pm-ksi, devops-agent,
   *  etc.) once a `references/` registry exists in the agent's workspace
   *  or repo root. See src/agents/references/. */
  contextReferences: z.boolean().default(false),
  maxConcurrent: z.number().default(1),
  /** Hard wall-clock cap on a single Claude Code invocation. Exceeding the
   *  cap sends SIGTERM (exit 143). Default 20 min — bump for devops/coder
   *  agents that do long investigations or multi-file refactors. */
  maxExecutionMinutes: z.number().int().min(1).max(240).default(20),
  permissionMode: z.string().default("default"),
  /** Improvement plan #3 — tool-use-required preset. When set,
   *  AgentX inspects the stream-json events from each task and
   *  fails the response with `tool_required_not_called: <name>`
   *  when none of the listed tool names was invoked. Catches the
   *  silent-degrade pattern observed when a model below the
   *  capability bar (e.g. Haiku on a Write-required prompt)
   *  produces a plausible-looking text response without ever
   *  calling the required tool. Caller can retry with a stronger
   *  model or sharpen the prompt.
   *
   *  Tool names match the canonical Claude Code names ("Write",
   *  "Edit", "Bash", "Read", …). Free-form so future tools work
   *  without a schema bump. Empty/unset means no enforcement
   *  (default — backward compatible). */
  toolUseRequired: z.array(z.string()).default([]),
  /** When true, this agent's claude-code dispatches reuse a long-lived
   *  subprocess per (channel, chatId) instead of spawning a fresh
   *  `claude -p` per turn. Driven over stdin via stream-json input,
   *  which keeps the prompt cache warm across turns within a chat
   *  (turn 1 cache_create=12897 → turn 2 cache_create=20 + cache_read
   *  =24575 in the 2026-05-03 spike — 3-5× latency win on chat-shaped
   *  workloads). When the registry can't allocate a slot (global or
   *  per-agent cap exceeded), the dispatch falls back to spawn-per-task
   *  silently with a warning log. Other tiers (sdk, orchestrator)
   *  ignore this flag. Default false until the persistent path
   *  finishes its soak; flip per-agent first, then per-fleet.
   *  See docs/architecture/persistent-claude-process.md for the design. */
  persistentProcess: z.boolean().default(false),
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
  /** When false, the daemon keeps the bot token registered so outbound
   *  `send()` / ring notifications work, but does NOT long-poll for inbound
   *  updates. Use this on nodes where the bound agent lives on a different
   *  daemon — otherwise two daemons race on the same `getUpdates` cursor and
   *  Telegram responds 409 Conflict on every poll.
   *  Defaults to true (poll) so existing single-node setups are unchanged. */
  pollInbound: z.boolean().default(true),
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
  github: z.object({
    enabled: z.boolean().default(false),
    /** GitHub PAT or env var (${GITHUB_TOKEN}) for posting comments back. */
    token: z.string().optional(),
    /** Path to file containing the token (first line read at startup). */
    tokenFile: z.string().optional(),
    /** GitHub App ID (legacy issuer). */
    appId: z.number().optional(),
    /** GitHub App Client ID (preferred JWT issuer per GitHub's updated docs). */
    clientId: z.string().optional(),
    /** Path to the GitHub App private key PEM file. */
    privateKeyFile: z.string().optional(),
    /** Webhook secret for validating X-Hub-Signature-256. */
    webhookSecret: z.string().optional(),
    /** Repo → agent routing. Use "owner/repo" or "*" for default. */
    routes: z.array(z.object({
      repo: z.string(),
      agent: z.string(),
    })).default([]),
    /** Per-agent identity mappings (GitHub usernames, tokens, mesh nodes). */
    agentMappings: z.array(z.object({
      agentId: z.string(),
      githubUsernames: z.array(z.string()).default([]),
      token: z.string().optional(),
      tokenFile: z.string().optional(),
      node: z.string().optional(),
    })).default([]),
  }).default({}),
  webrtc: z.object({
    enabled: z.boolean().default(false),
    /** ICE STUN servers for NAT discovery. Default is Google's public STUN. */
    stunServers: z.array(z.string()).default(["stun:stun.l.google.com:19302"]),
    /** Optional TURN relays (required when both peers are behind symmetric NAT). */
    turnServers: z.array(z.object({
      urls: z.string(),
      username: z.string().optional(),
      credential: z.string().optional(),
    })).default([]),
    /** Peer names permitted to *initiate* a call into this daemon. Empty = allow all mesh peers. */
    allowedCallers: z.array(z.string()).default([]),
    /** Where to send "someone is calling" notifications when an inbound ring
     *  arrives. Each entry is delivered via the matching channel adapter —
     *  same plumbing as any other outbound message. Empty disables notifications. */
    ringNotify: z.array(z.object({
      channel: z.string(),
      chatId: z.string(),
      accountId: z.string().optional(),
    })).default([]),
    /** Base URL used when building the tap-to-join link in ring notifications.
     *  Defaults to `http://<node.bind>` — override when the daemon's public
     *  hostname differs (e.g. HTTPS-terminated tunnel, Tailscale MagicDNS). */
    callUrlBase: z.string().optional(),
    /** AI participant ("bot") joins calls when a browser opens with `?bot=<id>`.
     *  v1 is transcribe-only — bot consumes remote audio, transcribes via
     *  Whisper, posts chunks to the configured channel. No TTS-back. */
    bot: z.object({
      enabled: z.boolean().default(false),
      /** Default agent id used to attribute the transcript when the URL
       *  doesn't override via `?bot=<other-agent>`. */
      defaultAgentId: z.string().optional(),
      /** "auto" tries mlx-whisper, falls back to OpenAI; explicit forces. */
      whisperBackend: z.enum(["auto", "mlx", "openai"]).default("auto"),
      whisperModel: z.string().optional(),
      whisperLanguage: z.string().default("auto"),
      /** Absolute path to mlx_whisper if not on the daemon's PATH (common
       *  on macOS launchd, where ~/.pyenv/shims is missing from the env). */
      mlxBinary: z.string().optional(),
      /** Where to send each transcribed chunk. Same shape as ringNotify[]. */
      transcriptChannel: z.object({
        channel: z.string(),
        chatId: z.string(),
        accountId: z.string().optional(),
      }).optional(),
      /** Hard cap so a forgotten bot doesn't run forever. */
      maxCallMinutes: z.number().int().min(1).max(240).default(30),
    }).default({}),
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
  /** Anthropic model id used for the direct classifier call (Phase 2 of
   *  classifier-retire). Default haiku — classification is metadata, not
   *  work, so we use the cheapest fast model. Override only if Haiku is
   *  rate-limited or you want to A/B test. */
  classifierModel: z.string().default("claude-haiku-4-5-20251001"),
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
  /** Workflow engine — declarative state machines that bind channel events
   *  to agents. Off by default; existing installs see no change until
   *  flipped. Definitions live under `dir` (default .agentx/workflows/). */
  workflows: z.object({
    enabled: z.boolean().default(false),
    dir: z.string().default(".agentx/workflows"),
    /** Controls whether the dashboard exposes the visual editor. "readonly"
     *  serves the list + run timelines but strips write controls from the
     *  page. "disabled" hides the tab entirely. */
    editor: z.enum(["disabled", "readonly", "edit"]).default("edit"),
  }).default({}),
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
    /** Per-event-type workflow routing. Keys are platform event-type
     *  strings — the format the platform's HTTP header uses, optionally
     *  joined with the action. Examples:
     *    GitHub: "issues.opened", "pull_request.synchronize",
     *            "push" (action-less events use the bare type)
     *    GitLab: "Note Hook", "Merge Request Hook"
     *  Values are workflow ids registered via `agentx workflow create`.
     *  When the inbound event-type matches a key, the named workflow is
     *  dispatched; if no key matches, the webhook falls through to
     *  `defaultWorkflow` (or the agent itself). Closes the recurring
     *  GitHub problem of multiple event types collapsing to a single
     *  workflow. */
    triggers: z.record(z.string(), z.string()).optional(),
    /** Workflow id used when no `triggers` entry matches the event-type.
     *  Backward-compatible: pre-existing webhooks without `triggers`
     *  always hit this path. */
    defaultWorkflow: z.string().optional(),
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
    tierTwoThresholdTokens: z.number().int().min(50_000).max(200_000).default(195_000),
    /** Context assembly strategy:
     *  - "layered" (default): the classic stacked layers — session history,
     *    memory, cross-chat, wiki hint all appended every turn.
     *  - "planner": a Haiku pre-call decides what to retrieve before the
     *    main agent runs. Always-on core is kept (channel/scope/landscape/
     *    identity/intent + last 3 turns verbatim); history blob, wiki hint,
     *    and cross-chat are replaced by planner-selected bundles. Per-task
     *    overrides via AgentTask.contextStrategy for A/B benchmarking. */
    contextStrategy: z.enum(["layered", "planner"]).default("layered"),
    /** Soft dispatch budget for claude-code-tier agents (shared OAuth pools
     *  one counter across the fleet). Warms at 80% of the cap; short-circuits
     *  cold dispatches (no warm Claude session) when exceeded. Warm sessions
     *  are always allowed through. Defaults sized for Max 5×:
     *   - maxClaudeCodeDispatchesPerHour: 80 (headroom under typical hourly cap)
     *   - maxClaudeCodeDispatchesPer5h: 180 (headroom under ~225/5h tier)
     *  Raise for Max 20×, lower if your workload stays under the cap naturally. */
    maxClaudeCodeDispatchesPerHour: z.number().int().min(1).max(10_000).default(80),
    maxClaudeCodeDispatchesPer5h: z.number().int().min(1).max(50_000).default(180),
  }).default({}),
  /** Move B — JS/TS plugins. Each entry is an installed npm package name
   *  (e.g. `agentx-plugin-mattermost` or `@noqta/plugin-mattermost`); the
   *  loader does a dynamic `import(name)` at boot, validates the manifest,
   *  and calls plugin.setup(ctx). Plugins can register channel adapters
   *  via ctx.addChannel() and subscribe to bus events via ctx.on(). Empty
   *  default — installs that don't list plugins are unaffected. Plugin
   *  authoring guide: docs/architecture/plugins.md. */
  plugins: z.array(z.string()).default([]),
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
 * Translate raw Zod issues into actionable, copy-pasteable fixes for the
 * patterns we see in real first-run failures (missing tokens, missing
 * required env vars, etc.). Falls through silently for unknown patterns —
 * the raw `issues` block is always shown above this hint block.
 */
function friendlyConfigHints(issues: ReadonlyArray<z.ZodIssue>, configPath: string): string[] {
  const hints: string[] = []
  const seen = new Set<string>()
  for (const issue of issues) {
    const path = issue.path.join(".")
    // Telegram account block exists but token is empty/missing — by far the
    // most common first-run trip. Tell the operator exactly which two
    // recoveries are valid, with the literal config path to edit.
    const tgTokenMatch = /^channels\.telegram\.accounts\.([^.]+)\.token$/.exec(path)
    if (tgTokenMatch && issue.message.toLowerCase().includes("required")) {
      const account = tgTokenMatch[1]
      const key = `tg:${account}`
      if (seen.has(key)) continue
      seen.add(key)
      hints.push(
        `Hint: Telegram account "${account}" is enabled but has no bot token.\n` +
        `  Either:\n` +
        `    A) Open ${configPath} and set channels.telegram.accounts.${account}.token to your bot token (or "\${TG_${account.toUpperCase()}_BOT_TOKEN}" + the matching .env entry).\n` +
        `    B) If you don't need Telegram on this instance, remove the entire "telegram" block under "channels" (or set channels.telegram.enabled to false AND drop accounts.${account}).`
      )
    }
  }
  return hints
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
    const hints = friendlyConfigHints(result.error.issues, foundPath)
    const hintBlock = hints.length ? `\n\n${hints.join("\n\n")}` : ""
    throw new Error(`Config validation failed (${foundPath}):\n${issues}${hintBlock}`)
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
