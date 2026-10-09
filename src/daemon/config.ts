import { z } from "zod"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { businessConfigSchema } from "@/business/config"
import { boardsConfigSchema, dashboardConfigSchema } from "@/boards/config"
import { autonomyLevelSchema } from "@/guard/autonomy"
import { DEFAULT_HOTKEYS, hotkeyError } from "@/voice/hotkey"
import { DEFAULT_PALETTE, ORB_PALETTE_IDS, VOICE_ANIMATIONS, VOICE_LOOKS } from "@/voice/orb-palettes"
import { SPOKEN_MAX_CHARS } from "@/voice/speakable"
import { NOISE_MARKERS } from "@/voice/noise"
import { whatsappTriageSchema } from "@/whatsapp-triage/config"
import { peopleProblem } from "@/people/people"
import { unknownAgentxTools } from "@/mcp/tool-names"

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

/** A list of agentx MCP tool names (session.lean.agentxTools). An unknown
 *  name is an error, not ignored: a misspelt `agentx_channel_reply` would
 *  otherwise leave a lean GitHub session with no way to reply. */
const agentxToolListSchema = z.array(z.string().min(1)).superRefine((list, ctx) => {
  const unknown = unknownAgentxTools(list)
  if (unknown.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `not an agentx tool: ${unknown.join(", ")}. Use the names the agentx server lists, without "mcp__agentx__".`,
    })
  }
})

const providerConfigSchema = z.object({
  apiKey: z.string().optional(),
  defaultModel: z.string().optional(),
  baseUrl: z.string().optional(),
  /** Toggle thinking-mode output on backends that support it (DeepSeek
   *  V4 `reasoning_content`). When `true` (the DeepSeek default), the
   *  agent streams its reasoning live in the dashboard task modal and
   *  the agentic round-trip echoes it back on the next iteration. Set
   *  to `false` to disable for cost/latency-sensitive agents. Ignored
   *  on backends that don't speak the thinking-mode protocol. */
  thinking: z.boolean().optional(),
})

const mcpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
})

const mcpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
})

// HTTP variant first so a record with `type: "http"` matches the HTTP
// shape; stdio is the default fallback when `type` is absent (keeps the
// original `{ command, args, env }` configs valid without a migration).
const mcpServerSchema = z.union([mcpHttpServerSchema, mcpStdioServerSchema])

/**
 * Per-agent integration registration. Declares which third-party services
 * an agent has credentials for — e.g. "@cx-bot has a Telegram bot token,
 * a HubSpot private app token, and a Gmail account". The actual secret is
 * NEVER stored in agentx.json: only an env-var reference (`tokenEnv`) or a
 * keyring directive. Skills, channel adapters, and the action layer read
 * from this registry to discover what an agent can use.
 *
 * The `kind` field is open-string (well-known values listed below in
 * INTEGRATION_KINDS) so new services can be declared without a schema
 * bump. Doctor warns on unknown kinds.
 */
const integrationCredentialsSchema = z.object({
  /** Env var holding the secret. Uppercase identifier; daemon resolves at use-time. */
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  /** Alternate env-var keys for credential schemes that need >1 secret
   *  (e.g. HubSpot private app + portal id, OAuth refresh tokens). */
  privateAppTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  refreshTokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  clientIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  /** OS keyring directive — credential lives in macOS Keychain / Linux
   *  Secret Service / Windows Credential Manager. The skill that reads
   *  this integration is responsible for resolving the keyring entry
   *  (typically keyed by agentId+kind). */
  auth: z.literal("keyring").optional(),
  /** File-based session directory (WhatsApp, Telegram MTProto, etc.). */
  sessionDir: z.string().optional(),
}).strict()

const integrationSchema = z.object({
  /** Service identifier — open string, well-known values in INTEGRATION_KINDS. */
  kind: z.string().min(1),
  /** Human-readable label (e.g. "@cx_bot", "Acme CRM", "alex@example.com"). Unique per (agent, kind). */
  label: z.string().min(1),
  credentials: integrationCredentialsSchema.default({}),
  /** Non-secret metadata — username, email, host URL, portal id, JID, etc.
   *  Visible in the dashboard and to skills. */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Operator-set toggle without removing the entry. */
  enabled: z.boolean().default(true),
})

export type Integration = z.infer<typeof integrationSchema>

/**
 * Canonical kind list — for autocomplete + doctor validation. Open string
 * schema so new services drop in without a bump; doctor warns when a kind
 * is outside this list.
 */
export const INTEGRATION_KINDS = [
  // Inbound channels
  "telegram-bot",
  "whatsapp",
  // Code platforms (user-scoped tokens, not channel routing)
  "gitlab-user",
  "github-user",
  // Email
  "gmail",
  "hotmail",
  "smtp",
  // CRM / ERP
  "hubspot",
  "salesforce",
  "pipedrive",
  "odoo",
  // Project management
  "trello",
  "linear",
  "asana",
  "jira",
  "notion",
  // Payments
  "stripe",
  // Observability / hosting
  "sentry",
  "vercel",
  // Voice / SMS
  "twilio",
  // Catch-all
  "custom",
] as const

const voiceProviderSchema = z.enum(["system", "elevenlabs"])

/** A macOS voice: a name ("Daniel", "Ava (Premium)") or identifier;
 *  "system" for the OS default voice (the only way to get a Siri voice);
 *  or one per language, picked by the language of each line:
 *  { "en": "Samantha", "fr": "Thomas", "ar": "Majed" }. */
const systemVoiceSchema = z.union([z.string(), z.record(z.string(), z.string())])

/** A keyboard shortcut for AgentX Voice, e.g. "opt+space" or
 *  "ctrl+opt+1". See src/voice/hotkey.ts. */
const hotkeySchema = z.string().superRefine((s, ctx) => {
  const error = hotkeyError(s)
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `shortcut ${error}` })
})

const voiceSchema = z.object({
  /** Overrides the global voice.provider for this agent. */
  provider: voiceProviderSchema.optional(),
  /** See systemVoiceSchema. Unset: one is assigned, of the agent's
   *  gender when set, different from every other agent's. */
  system: systemVoiceSchema.optional(),
  /** Voices to try, in order, when `system` names one that is not
   *  installed (e.g. ["Ava (Premium)", "Allison"]). Unset, or none
   *  installed: the best installed voice of its language and gender. */
  fallbacks: z.array(z.string().min(1)).optional(),
  elevenlabsVoiceId: z.string().optional(),
  gender: z.enum(["female", "male", "neutral"]).optional(),
  /** A few words on manner, e.g. "warm, upbeat, a little playful". */
  style: z.string().optional(),
  /** The one-line self-introduction used on first contact. */
  intro: z.string().optional(),
  /** Speak short updates from this agent's real tool steps while it
   *  works: "on" for everything but cron, "all" to include cron. */
  narrate: z.enum(["off", "on", "all"]).optional(),
  /** Speaking speed, 1 = normal. System voices: 175 words a minute times
   *  this. ElevenLabs accepts 0.7 to 1.2 and is held to that range. */
  rate: z.number().min(0.75).max(1.5).optional(),
  /** Place in the speaking queue: "high" lines go ahead of waiting
   *  "normal" ones, "low" lines after them. Unset: normal. */
  priority: z.enum(["high", "normal", "low"]).optional(),
  /** AgentX Voice: hold this shortcut and speak to ask this agent, without
   *  changing the agent picked in the menu. */
  hotkey: hotkeySchema.optional(),
})

/** One event subscription (src/events/subscriptions.ts). An envelope
 *  matches when its kind or type is in `kinds` and every other set filter
 *  agrees. Every subscription is readable with `agentx_events`; `digest`
 *  also briefs a fresh session and `wake` also starts a turn. */
export const eventSubscriptionSchema = z.object({
  /** Envelope `kind` ("agent", "run") or `type` ("task:completed"); "*" matches all. */
  kinds: z.array(z.string().min(1)).min(1),
  /** Only events published for these agent ids. */
  agents: z.array(z.string().min(1)).optional(),
  /** Only events published by these nodes (`node.name`). */
  nodes: z.array(z.string().min(1)).optional(),
  /** Only events whose summary contains this text (case-insensitive). */
  match: z.string().min(1).optional(),
  delivery: z.enum(["pull", "digest", "wake"]).default("pull"),
  /** wake only: no wake when the agent was already woken this many times
   *  in the past hour. */
  maxPerHour: z.number().int().min(1).max(60).default(4),
})

const agentConfigSchema = z.object({
  name: z.string(),
  workspace: z.string(),
  tier: z.enum(["claude-code", "codex-cli", "opencode", "sdk", "orchestrator"]).default("claude-code"),
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
  /** Enable CodeGraph (https://github.com/colbymchenry/codegraph) for this
   *  agent's claude-code or codex-cli workspace. When true, agentx (a) adds
   *  a codegraph MCP server to <workspace>/.mcp.json, (b) extends
   *  .claude/settings.json permissions.allow with the codegraph_* tools,
   *  (c) appends a CodeGraph instruction section to the managed CLAUDE.md,
   *  and (d) background-indexes the workspace at daemon boot if .codegraph/
   *  is missing. Off by default — flip on for coding agents (globex-v2-coder,
   *  initech-v2-coder, umbrella-coding, etc.) where token-volume on exploration
   *  loops is the bottleneck. */
  codegraph: z.boolean().default(false),
  /** Per-agent override for the global `session.contextStrategy`. Lets
   *  one agent run `planner` (smaller upfront context, more tool-driven
   *  exploration) while siblings stay on `layered`. Used for agents that
   *  consistently bloat their cache via large workspace reads. */
  contextStrategy: z.enum(["layered", "planner"]).optional(),
  /** When true, the registry resolves references-recipes for this agent's
   *  workspace and renders a deterministic [Verified References] block at
   *  priority 4.7. Off by default — flip on per agent (pm-initech, devops-agent,
   *  etc.) once a `references/` registry exists in the agent's workspace
   *  or repo root. See src/agents/references/. */
  contextReferences: z.boolean().default(false),
  /** Whether this agent may emit in-band `agentx:ui` rich-message directives
   *  (buttons/polls/media) on chat channels. Default true — set false to make
   *  the render layer strip any directive and send plain text only. */
  richMessages: z.boolean().default(true),
  maxConcurrent: z.number().default(1),
  /** Hard wall-clock cap on a single Claude Code invocation. Exceeding the
   *  cap sends SIGTERM (exit 143). Default 20 min — bump for devops/coder
   *  agents that do long investigations or multi-file refactors. */
  maxExecutionMinutes: z.number().int().min(1).max(240).default(20),
  /** Time a run may spend between taking a slot and starting its agent
   *  process (request gate, classifier, compaction, context planning, model
   *  routing, dispatch gates). Past it the run is aborted, its slot freed and
   *  its record marked `timeout` with the step it was stuck in. Applies to
   *  every run, whatever started it. */
  preSpawnTimeoutSec: z.number().int().min(10).max(3600).default(300),
  /** How long a daemon stop waits for this agent's runs before cutting
   *  them off, when that is longer than shutdown.drainTimeoutSeconds. For
   *  agents whose runs are long (renders, builds). */
  drainTimeoutSeconds: z.number().int().min(0).max(86_400).optional(),
  /** Wiki settings for this agent. `contribute` turns on its daily wiki
   *  contribution (#824): `agentx wiki contribute --all` reviews the
   *  agent's work since its last run and queues sourced patches for the
   *  daily merge. Off by default. `maxPatches` and `maxCostUsd` cap one
   *  run; `model` overrides the wiki-wide model. `absorb` leaves the
   *  agent out of the bulk absorb. */
  wiki: z.object({
    contribute: z.object({
      enabled: z.boolean().default(false),
      maxPatches: z.number().int().min(1).max(200).default(30),
      maxCostUsd: z.number().min(0).max(20).optional(),
      model: z.string().optional(),
    }).default({}),
    /** Whether `agentx wiki absorb` without `--agent` compiles this
     *  agent's raw entries (#850). On by default. Off, the agent is skipped
     *  and named; its raw entries are still captured, so absorb can resume
     *  later with nothing lost. `--agent <id>` still runs it. */
    absorb: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
  }).optional(),
  permissionMode: z.string().default("default"),
  /** How this agent's `claude` CLI is billed (claude-code tier). Default
   *  "subscription": the shared OAuth login, ANTHROPIC_API_KEY stripped.
   *  "api": bill ANTHROPIC_API_KEY instead and drop the OAuth token, so
   *  e.g. benchmark agents never draw on the fleet's subscription quota.
   *  An "api" agent with no key fails its task rather than falling back. */
  billing: z.enum(["subscription", "api"]).default("subscription"),
  /** Run GitHub coding tasks as Claude cloud sessions (`claude --cloud`)
   *  instead of local runs (#622). Off by default. Needs
   *  `channels.github.cloudSessions: true` too. Only a task from the GitHub
   *  channel for an issue or pull request of a repository this node has a
   *  checkout of (the project rule's `runbook` path, or the agent's
   *  workspace) goes to the cloud; everything else runs locally. The result
   *  is a pull request, not a reply. A launch that fails falls back to a
   *  local run. See src/agents/cloud-sessions.ts. */
  cloudSessions: z.object({
    enabled: z.boolean().default(false),
    /** Launches per calendar day for this agent; 0 = no cap. */
    maxPerDay: z.number().int().min(0).default(0),
    /** Hours a launched session counts as open: no local run starts for
     *  its issue, and comments on the issue are forwarded to it. */
    openHours: z.number().min(1).max(168).default(24),
    /** Seconds `claude --cloud` may take to print the session id before
     *  the launch is given up and the task runs locally. */
    launchTimeoutSeconds: z.number().int().min(10).max(600).default(120),
  }).default({}),
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
  /** Per-agent override for the channel-level `autoReplyLegacy` on
   *  gitlab/github. When set, it wins over `channels.<name>.autoReplyLegacy`
   *  for this agent's replies: `true` makes the daemon auto-post the agent's
   *  final text as a comment (right for coder agents that end their turn with
   *  a summary and don't call `agentx_channel_reply`); `false` suppresses it
   *  (right for chatty agents whose reasoning shouldn't land as a comment).
   *  Unset → fall back to the channel default. */
  gitlabAutoReply: z.boolean().optional(),
  /** Opt into process reuse for claude-code (stream-json) or codex-cli
   *  (app-server), or opencode (dedicated v2 server). Conversations have isolated processes. Unsupported Codex
   *  versions fall back to exec before submitting any turn. Other tiers
   *  ignore this flag. Codex loads the operator's Codex config, unlike exec's
   *  --ignore-user-config path: review additional MCP servers before enabling.
   *  Codex and OpenCode each use an 8-process cap and 5-minute idle eviction; processPool
   *  settings apply to Claude only. Default false for gradual rollout.
   *  See docs/architecture/persistent-codex-process.md and
   *  docs/architecture/persistent-claude-process.md and
   *  docs/architecture/persistent-opencode-process.md for details. */
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
  /** Governance override for agent-facing management tools. An admin agent
   *  may pause, resume and request deletion of schedules created by other
   *  agents or by the operator. It never approves anything: approval of a
   *  create/delete request stays operator-only (`agentx schedule approve`). */
  admin: z.boolean().optional(),
  /** Events on the bus this agent wants to hear about (issue #165). */
  subscriptions: z.array(eventSubscriptionSchema).default([]),
  /** Per-agent third-party integrations registry. Declares which services
   *  this agent has credentials for (telegram-bot, hubspot, gitlab-user,
   *  gmail, etc.). Secrets stay in env vars / keyring; this block holds
   *  declarations + non-secret metadata only. Skills and channel adapters
   *  read from here to know what the agent can use. See INTEGRATION_KINDS. */
  integrations: z.array(integrationSchema).default([]),
  /** How this agent sounds when it speaks (voice widget, `agentx teach`).
   *  Every field is optional: no voice id falls back to the global
   *  AGENTX_VOICE_ID, no intro is derived from the system prompt. See
   *  src/voice/agent-voice.ts. */
  voice: voiceSchema.optional(),
  /** How this agent appears on screen: its own cursor, drawn by the Mac
   *  helper and click-through, never the person's real mouse. See
   *  src/voice/presence.ts. */
  presence: z.object({
    /** Cursor colour, as #RRGGBB. Default: derived from the agent id. */
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    /** The voice orb's gradient, one of src/voice/orb-palettes.ts.
     *  Default: the palette nearest `color`. */
    palette: z.enum(ORB_PALETTE_IDS).optional(),
    /** One or two letters on the cursor. Default: from the name. */
    initial: z.string().max(2).optional(),
    /** Name shown under the cursor. Default: the agent's name. */
    label: z.string().optional(),
    /** May this agent click and type for the person (presence mode "act")?
     *  Off by default: without it, "act" becomes "teach". */
    allowActions: z.boolean().optional(),
  }).optional(),
})

const telegramAccountSchema = z.object({
  token: z.string(),
  agentBinding: z.string(),
  /** Per-account sender allowlist. When set, OVERRIDES the global
   *  `policy.allowFrom`. Entries accept:
   *    - numeric user id  ("1816212449")         — matches sender (from.id)
   *    - numeric chat id  ("-1003861455814")     — matches chat (chat.id)
   *    - "@username"                             — matches sender username
   *    - "*"                                     — matches everyone (public bot)
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

/** An agent watching the phone camera (#325 phase 2, src/camera/watch.ts). */
export const cameraBotSchema = z.object({
  /** Seconds between frames the agent gets by itself. 0: only when asked
   *  ("Look now" on the phone, or the agent's own `agentx camera look`).
   *  Each frame handed over by itself is a turn of the agent, so keep
   *  this high or off. */
  frameIntervalSeconds: z.number().int().min(0).max(3600).default(0),
  /** The agent's watch ends after this many minutes, whatever the phone does. */
  maxSessionMinutes: z.number().int().min(1).max(240).default(10),
  /** Frames are shrunk so their longer side is at most this many pixels
   *  before the agent sees them. */
  maxFrameEdge: z.number().int().min(160).max(3840).default(1024),
  /** Keep the frame files in the agent's workspace after the share ends.
   *  Off: every frame is deleted when the share ends. */
  keepFrames: z.boolean().default(false),
  /** "Keep watching" on the phone (#687): for a task that needs a stream
   *  ("watch while I do this"), the agent gets a frame every this many
   *  seconds, only while the owner has it on. */
  streamFrameSeconds: z.number().int().min(2).max(60).default(5),
  /** "Keep watching" stops by itself after this many seconds. */
  streamMaxSeconds: z.number().int().min(10).max(600).default(60),
}).default({})

export type CameraBotConfig = z.infer<typeof cameraBotSchema>

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
       *  per-account list (user id, chat id, @username, or "*" for everyone). */
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
  gitlab: z.object({
    enabled: z.boolean().default(false),
    webhookPort: z.number().default(18810),
    webhookSecret: z.string().optional(),
    host: z.string().default("https://gitlab.com"),
    token: z.string().optional(),
    /** Legacy auto-reply: when true (default), the router posts the agent's
     *  `response.content` as a comment automatically. When false, the agent
     *  must call the `channel.reply` action explicitly to reply — agent
     *  reasoning text is logged but not posted. Flip to false once the
     *  project's agents have migrated their gitlab skill to use channel.reply.
     *  Default true preserves today's behaviour for unmigrated projects. */
    autoReplyLegacy: z.boolean().default(true),
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
       *  like two agents both claiming @devops-acme. */
      node: z.string().optional(),
    })).default([]),
    /** Extra GitLab usernames each agent answers to, as prefixes. With
     *  ["team-"], an agent with no agentMappings row answers to @<id> and
     *  @team-<id>. Default: only @<id>. */
    agentUsernamePrefixes: z.array(z.string().min(1)).default([]),
  }).default({}),
  github: z.object({
    enabled: z.boolean().default(false),
    /** Legacy auto-reply — same semantics as gitlab.autoReplyLegacy.
     *  Defaults true; set false once agent skills use channel.reply. */
    autoReplyLegacy: z.boolean().default(true),
    /** Let agents whose `cloudSessions.enabled` is on send this channel's
     *  issue and pull request tasks to Claude cloud sessions (#622). Off by
     *  default: both this and the agent setting must be on. */
    cloudSessions: z.boolean().default(false),
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
    // --- Which issue and pull request events start a run (#612) ---
    /** Issue actions that start a run. A project rule whose `actions`
     *  list is set replaces this list for its repository; a rule without
     *  one keeps it, so `closed` never starts a run unless asked for. */
    issueActions: z.array(z.string().min(1)).default(["opened", "reopened", "assigned"]),
    /** Pull request actions that start a run. Same precedence as issueActions. */
    pullRequestActions: z.array(z.string().min(1)).default(["opened", "reopened", "ready_for_review"]),
    /** A label, assignment, close or edit made by an account AgentX posts
     *  with (the App bot, a token owner, a mapped username, a mesh peer)
     *  does not start a run: the owner sweep's own `agent:<id>` label woke
     *  the agent it was filed for. Opened and reopened always count. */
    ignoreOwnChanges: z.boolean().default(true),
    /** Events on one issue or pull request within this many seconds become
     *  one run, carrying the latest state. The window restarts with each
     *  event. 0 starts a run per event. */
    debounceSeconds: z.number().min(0).max(3600).default(30),
  }).default({}),
  /** ntfy push notifications — outbound only. The operator-facing tap on
   *  the shoulder: cron failures, task errors, and anything an agent decides
   *  is worth interrupting a human for. `chatId` on an outgoing message is
   *  the topic; empty falls back to `topic` here. */
  ntfy: z.object({
    enabled: z.boolean().default(false),
    /** Self-hosted ntfy base URL. Defaults to the public server. */
    server: z.string().default("https://ntfy.sh"),
    /** Default topic. Treat it as a secret — on ntfy.sh, knowing the topic
     *  is the only thing needed to read or publish to it. */
    topic: z.string().optional(),
    /** Access token for protected topics. */
    token: z.string().optional(),
    /** 1 (min) .. 5 (max). ntfy's own default is 3. */
    defaultPriority: z.number().int().min(1).max(5).default(3),
    defaultTitle: z.string().optional(),
  }).default({}),
  /** Web Push to the phone app (/app) — outbound only. The node that hosts
   *  the app holds the subscriptions and sends; any other node sets
   *  `relayTo` and forwards over the mesh. `chatId` "default" means every
   *  subscribed phone, or a device id (tok_…) for one. */
  push: z.object({
    enabled: z.boolean().default(false),
    /** VAPID key pair written by `agentx app push-keys`. Relative paths
     *  resolve from the folder AgentX runs in (the one holding agentx.json). */
    keysFile: z.string().default(".agentx/push-keys.json"),
    /** Contact for the push services: `mailto:you@example.com` or an
     *  https:// URL. Required on the hosting node. */
    subject: z.string().regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://").optional(),
    /** Mesh peer (id or name) that hosts the phone app. Set it on every
     *  other node; leave it unset on the host. */
    relayTo: z.string().optional(),
    /** How long a push service keeps trying an offline phone. */
    ttlSeconds: z.number().int().min(0).max(2419200).default(86400),
    /** Recent pushes kept for the app's Alerts tab. */
    keepRecent: z.number().int().min(0).max(1000).default(50),
    /** Push-service hosts a phone may subscribe with (a host or any
     *  subdomain of it). The daemon POSTs to the stored address, so anything
     *  else is refused. Defaults cover Chrome/Android, Firefox, Safari/iOS
     *  and Edge. */
    allowedHosts: z.array(z.string().min(1)).default([
      "fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com",
    ]),
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
    /** The phone app's Share camera (#325). The phone asks for this size and
     *  rate; the browser picks the nearest the camera supports. The share
     *  stops by itself after maxSeconds. */
    camera: z.object({
      width: z.number().int().min(160).max(3840).default(1280),
      height: z.number().int().min(120).max(2160).default(720),
      frameRate: z.number().int().min(1).max(60).default(15),
      maxSeconds: z.number().int().min(10).max(7200).default(600),
      /** Ask the watching agent by voice: hold or tap Talk (#687). Off: the
       *  phone shows the text box only. The microphone opens only while
       *  you talk and is never part of the share. */
      voiceInput: z.boolean().default(true),
      /** Say the watching agent's answers aloud on the phone, in the
       *  agent's voice or the phone's own. The owner can mute it there. */
      speakAnswers: z.boolean().default(true),
      /** An agent watching the phone camera. The bot keeps only the newest
       *  frame; the agent gets one when asked, and every
       *  frameIntervalSeconds when that is set. */
      bot: cameraBotSchema,
    }).default({}),
  }).default({}),
})

const cronJobSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: z.string(),
  timezone: z.string().default("UTC"),
  agent: z.string(),
  prompt: z.string().default(""),
  /**
   * A shell command to run INSTEAD of dispatching the agent.
   *
   * Seven of this fleet's twenty-six crons were a single command wrapped
   * in an agent, and every one of them carried a paragraph like "Run this
   * EXACT command. Do NOT substitute, rewrite, shorten, or fall back to
   * alternative commands." That paragraph is a scar: it exists because
   * models kept substituting, and no amount of prompt severity makes a
   * language model a deterministic executor.
   *
   * Measured before this existed: ~$0.31 and ~24s per run to execute one
   * `node script.js` and repeat ten lines of its output — a 114k-token
   * context for a job with no judgement in it at all.
   *
   * When set, the scheduler runs the command directly. No model, no
   * tokens, no improvisation. `agent` is still required and is who gets
   * told when it fails.
   */
  command: z.string().optional(),
  timeout: z.number().default(600),
  model: z.string().optional(),
  /** Soft cap on output length. Claude Code CLI has no hard flag for this,
   *  but appending an instruction to the prompt is reliably honored. Use
   *  1500 for briefs, 500 for status pings, 300 for pure classifiers. */
  maxOutputTokens: z.number().int().min(50).max(8000).optional(),
  /** How much this routine may do: `report` (read-only), `propose` (branch,
   *  commit, MR/draft; never merge/deploy/delete) or `act` (the agent's full
   *  permissions — the default). Enforced per run by the guard, not by the
   *  prompt; only the claude-code tier can enforce it, others refuse. */
  autonomy: autonomyLevelSchema.optional(),
  onError: z.union([
    z.enum(["log", "notify", "disable"]),
    z.array(z.enum(["log", "notify", "disable"])),
  ]).default("log").transform(v => Array.isArray(v) ? v : [v]),
  notify: z.object({
    channel: z.string(),
    chatId: z.string(),
    accountId: z.string().optional(),
  }).optional(),
  /** Whether each successful run's answer is sent to `notify` (failures
   *  are alerted there either way). Default on: a schedule with somewhere
   *  to report reports there, including the chat an agent's schedule was
   *  requested from (#738). `false` keeps `notify` for failure alerts only. */
  deliverResult: z.boolean().optional(),
  /** Secret that lets an external system fire this job now via
   *  `POST /routines/<id>/fire`. Reference an env var (`"${MY_TOKEN}"`);
   *  a job without one cannot be fired. See src/daemon/routine-fire.ts. */
  fireToken: z.string().optional(),
  /** Agent id that created this job through the agent `schedule` tool.
   *  Absent for operator-created jobs. Drives the ownership rule: an agent
   *  manages only the routines it created, unless it is `admin`. */
  createdBy: z.string().optional(),
  /** Pending operator approval for an agent-requested change. While a
   *  `create` is pending the job never runs, whatever `enabled` says; a
   *  pending `delete` leaves the job as it was until approved. Cleared by
   *  `agentx schedule approve|reject <id>`. */
  approval: z.object({
    action: z.enum(["create", "delete"]),
    requestedBy: z.string(),
    requestedAt: z.string(),
  }).optional(),
}).refine((j) => Boolean(j.command?.trim() || j.prompt?.trim()), {
  message: "a cron needs either a prompt (dispatch an agent) or a command (run it directly)",
}).refine((j) => !(j.command?.trim() && j.autonomy && j.autonomy !== "act"), {
  message: "autonomy applies to agent routines; a command cron runs no agent (remove autonomy or the command)",
})

/** Whether `expr` is a 5-field cron the scheduler can read: each field a
 *  `*`, a number or a range, with an optional `/step`, comma-separated,
 *  inside the field's bounds. */
export function isCronExpression(expr: string): boolean {
  const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]]
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  return fields.every((field, i) => field.split(",").every((part) => {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) return false
    const [min, max] = bounds[i]
    const a = m[2] === undefined ? min : Number(m[2])
    const b = m[3] === undefined ? a : Number(m[3])
    const step = m[4] === undefined ? 1 : Number(m[4])
    return a >= min && b <= max && a <= b && step >= 1
  }))
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** A repository a live read may name: `owner/name`, or a GitLab path. */
const wikiLiveRepoName = z.string().regex(/^(?!.*(?:^|\/)\.+(?:\/|$))[\w.-]+(\/[\w.-]+)+$/, "expected owner/name")
const wikiLiveRepoSchema = z.union([
  wikiLiveRepoName,
  z.object({
    repo: wikiLiveRepoName,
    /** What lives there, shown to the model so it names the right one. */
    about: z.string().max(200).optional(),
  }),
])
const wikiLiveTokenFields = {
  /** Name of the environment variable that holds the token. */
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  /** File whose first line is the token. */
  tokenFile: z.string().optional(),
}
/** Where `wiki query` may read live state from (#855). Read-only: each
 *  read is one HTTP GET built by code (src/wiki/live-read.ts). */
const wikiLiveSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("github"),
    apiUrl: z.string().url().default("https://api.github.com"),
    ...wikiLiveTokenFields,
    repos: z.array(wikiLiveRepoSchema).min(1),
  }),
  z.object({
    type: z.literal("gitlab"),
    /** The GitLab host. Unset: `channels.gitlab.host`. */
    url: z.string().url().optional(),
    ...wikiLiveTokenFields,
    repos: z.array(wikiLiveRepoSchema).min(1),
  }),
  z.object({
    type: z.literal("agentx"),
    /** The daemon to ask. Unset: this node. */
    url: z.string().url().optional(),
    /** Also ask each mesh peer the daemon lists. */
    peers: z.boolean().default(true),
  }),
])

/** Notes agents leave for the wiki observe/sweep run (#825, src/wiki/notes.ts).
 *  Off by default. Every node that should be able to post sets the same
 *  `inbox`; only the inbox agent's node lists `crons`. */
const wikiNotesSchema = z.object({
  enabled: z.boolean().default(false),
  /** Agent that runs the wiki observe/sweep schedule. Notes are addressed
   *  to it and kept on its node. */
  inbox: z.string().min(1).optional(),
  /** Schedule ids (keys of `crons`) that read the inbox when they start.
   *  Each must run as the inbox agent. Empty: notes are kept but no run
   *  reads them. */
  crons: z.array(z.string().min(1)).default([]),
  /** Agent whose `agentx wiki absorb` pass reads the inbox (#831). Absorb
   *  is one model call with no tools: it gets the notes in its prompt,
   *  answers each, and absorb applies the patches and records the
   *  outcome. Unset: absorb reads no notes. Must run on this node, the
   *  node that keeps the inbox. */
  absorbAgent: z.string().min(1).optional(),
  /** Most notes one run is given. The rest wait for the next run. */
  maxNotesPerRun: z.number().int().min(1).max(100).default(20),
  /** A note deferred this many times stops being offered (status
   *  `expired`), so notes nobody can check do not crowd out new ones. */
  maxDeferrals: z.number().int().min(1).max(20).default(3),
}).refine((n) => !n.enabled || Boolean(n.inbox), {
  message: "wikiNotes.enabled needs wikiNotes.inbox: the agent that runs the wiki observe/sweep schedule",
})

export type WikiNotesConfig = z.infer<typeof wikiNotesSchema>

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

/** A named, operator-declared destination that remote mesh nodes may send
 *  to. Deliberately minimal: the published surface is the name and whether
 *  it accepts, so there is nothing here that could leak local state if it
 *  were echoed back. Which agent handles it stays private to this node. */
const meshInboxSchema = z.object({
  name: z.string(),
  agent: z.string(),
  enabled: z.boolean().default(true),
})

const meshConfigSchema = z.object({
  enabled: z.boolean().default(false),
  peers: z.array(meshPeerSchema).default([]),
  /** Empty by default — a node publishes no inboxes until an operator
   *  declares one, so this feature is opt-in per node. */
  inboxes: z.array(meshInboxSchema).default([]),
  discovery: z.enum(["static", "mdns"]).default("static"),
  healthCheck: z.object({
    interval: z.number().default(60),
    timeout: z.number().default(10),
  }).default({}),
  /** Peer event feed (#166): follow each healthy peer's /events and merge
   *  its own events into this node's bus. `skipTypes` are left out on the
   *  peer's side; per-step agent activity is too chatty to cross the mesh. */
  feed: z.object({
    enabled: z.boolean().default(true),
    skipTypes: z.array(z.string().min(1)).default(["task:step"]),
  }).default({}),
  /** Agent-to-agent delegation (#277), local or across peers. When a person
   *  started the conversation, a delegation returns at once and the answer
   *  comes back to the asking agent as a new turn in the same chat. */
  delegation: z.object({
    /** Off: every delegation waits for its answer, as before. */
    asyncWhenHuman: z.boolean().default(true),
    /** A delegation with no answer after this long is reported as timed out. */
    timeoutMinutes: z.number().int().min(1).max(240).default(30),
    /** A restart that stops the turn passing a delegation's answer on to
     *  the person (#846): run that turn once more after the next start,
     *  and if it fails again, tell the person and note the open request. */
    requeueRelayOnRestart: z.boolean().default(true),
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

// --- Typed-decision seats (src/decisions) ---
//
// Everything here defaults off. A seat in "shadow" runs alongside the
// incumbent and only records; "active" lets its answer steer behaviour, and
// no seat should reach it before its calibration report says what threshold
// to use and what that threshold costs.
const decisionSeatSchema = z.object({
  /** off: the seat is unreachable. shadow: runs and records, incumbent stays
   *  authoritative. active: the answer is used. */
  mode: z.enum(["off", "shadow", "active"]).default("off"),
  /** Backend name from the decisions registry. Per-seat, so one seat can be
   *  graded against a different backend than another at the same time. */
  backend: z.string().optional(),
  model: z.string().optional(),
  /** Unset: 10 s (DEFAULT_SEAT_TIMEOUT_MS), except where a call site sets
   *  its own default, as request-gate and request-context do (3 s). Left
   *  without a schema default so those seats can tell a value the operator
   *  wrote from one nobody chose. */
  timeoutMs: z.number().int().min(100).optional(),
  /** Post-hoc temperature fitted on this seat's own labeled rows. 1 means
   *  "not calibrated yet", which is where every seat starts — see
   *  `agentx decisions calibrate`. */
  temperature: z.number().min(0.01).default(1),
  /** Fraction of would-be-skips to run anyway. Not a tuning knob: a skipped
   *  decision can never be graded, so without exploration an active seat's
   *  metrics are computed on the biased sample it selected for itself.
   *  Setting this to 0 in active mode means the calibration report stops
   *  being trustworthy the day you promote the seat. */
  explore: z.number().min(0).max(1).default(0.15),
  /** Fraction of turns that bypass the seat as a randomized control group.
   *  Unset lets the seat pick its own default; only seats that run an
   *  experiment read it (today: request-gate, default 0.1). */
  holdout: z.number().min(0).max(1).optional(),
}).default({})

const decisionsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string().default(".agentx/decisions/decisions.sqlite"),
  /** State can contain message text. With this on, only the hash is kept,
   *  which costs the ability to replay a decision offline. */
  redactState: z.boolean().default(false),
  /** Keep the serialized state for this many rows per seat, then prune to
   *  hashes. Enough to replay and to grade an alternative backend on
   *  identical inputs, without growing without bound. */
  keepStateRows: z.number().int().min(0).default(2000),
  defaultBackend: z.string().default("local"),
  backends: z.object({
    local: z.object({
      provider: z.string().default("claude-code"),
      model: z.string().default("claude-haiku-4-5-20251001"),
      /** auto resolves to a forced tool where the provider guarantees one,
       *  and JSON-in-text otherwise (claude-code on OAuth cannot force a
       *  tool). Never resolves to logprobs: that costs one call per
       *  question, so it has to be asked for. */
      structureMode: z.enum(["auto", "tool", "text"]).default("auto"),
      normalizeProbabilities: z.boolean().default(true),
      nRetryMalformedStructure: z.number().int().min(0).max(3).default(1),
      maxStateChars: z.number().int().min(500).default(24_000),
    }).default({}),
    /** A simple-jev server (featherless-ai/simple-jev). Reads the model's
     *  next-token logits rather than asking it to write a probability, so
     *  the distribution is the model's posterior instead of a number it
     *  chose. Still not calibrated to correctness — that comes from
     *  `agentx decisions recalibrate`. */
    simpleJev: z.object({
      baseUrl: z.string().default("http://127.0.0.1:8000/v1"),
      model: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      timeoutMs: z.number().int().min(100).default(30_000),
      maxStateChars: z.number().int().min(500).default(6_000),
      /** Their Choice takes 2-50 candidates, well under Jev's 255. */
      maxChoiceOptions: z.number().int().min(2).max(255).default(50),
    }).default({}),
    /** TypeSafe Jev through OpenRouter's alpha decisions endpoint.
     *  Verified live 2026-09-19 — resolves to typesafe/jev-1.13-20260917,
     *  provider "TypeSafe", ~0.5s round trip. The id is "jev-latest";
     *  the namespaced "typesafe/jev-latest" 400s, and neither appears in
     *  OpenRouter's public model list. Needs OPENROUTER_API_KEY. */
    jev: z.object({
      baseUrl: z.string().default("https://openrouter.ai/api/alpha"),
      path: z.string().default("/decisions"),
      model: z.string().default("jev-latest"),
      apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
      timeoutMs: z.number().int().min(100).default(30_000),
      maxStateChars: z.number().int().min(500).default(90_000),
      maxChoiceOptions: z.number().int().min(2).max(255).default(255),
    }).default({}),
    /** Jev direct from TypeSafe rather than through OpenRouter. Same
     *  contract, different billing and rate limits. Needs TYPESAFE_API_KEY. */
    typesafe: z.object({
      baseUrl: z.string().default("https://api.typesafe.ai/v1"),
      path: z.string().default("/systemone"),
      model: z.string().default("jev-latest"),
      apiKeyEnv: z.string().default("TYPESAFE_API_KEY"),
      timeoutMs: z.number().int().min(100).default(30_000),
      maxStateChars: z.number().int().min(500).default(90_000),
      maxChoiceOptions: z.number().int().min(2).max(255).default(255),
    }).default({}),
  }).default({}),
  seats: z.record(z.string(), decisionSeatSchema).default({}),
  /** Model routing driven by the task-tier seat. Models are scoped to their
   *  CLI engine; the legacy cheapModel applies only to Claude Code. */
  routing: z.object({
    cheapModel: z.string().optional(),
    cheapModels: z.object({
      "claude-code": z.string().optional(),
      "codex-cli": z.string().optional(),
    }).optional(),
  }).default({}),
}).default({})

/** Agents ringing the owner for a live voice call (src/calls). */
export const callsSchema = z.object({
  /** Agents allowed to call: ids, or "*" for every agent on this node.
   *  Empty: nobody can call until the owner allows it. */
  allow: z.array(z.string()).default([]),
  /** Most calls one agent may place in an hour. */
  maxPerHour: z.number().int().min(1).max(60).default(3),
  /** How long a call rings before it counts as missed. */
  ringSeconds: z.number().int().min(10).max(300).default(45),
  /** An answered call nobody hung up (widget quit or crashed, the Mac
   *  slept, `agentx call answer` without a conversation) ends after this,
   *  so the agent can call again. */
  maxCallMinutes: z.number().int().min(1).max(240).default(30),
  /** Ring sound: a name from /System/Library/Sounds, without the extension. */
  ringSound: z.string().regex(/^[\w -]+$/).default("Submarine"),
  /** After hang-up, ask the agent for a short summary and file it in the
   *  dashboard's conversation history. */
  summary: z.boolean().default(true),
}).default({})

export type CallsConfig = z.infer<typeof callsSchema>

const notificationsSchema = z.object({
  /** Send notification when task takes longer than this (seconds). 0 = disabled. */
  longTaskThreshold: z.number().default(30),
  /** Where to send notifications */
  destination: z.object({
    channel: z.string(),
    chatId: z.string(),
    accountId: z.string().optional(),
  }).optional(),
  /** Channel `agentx notify` and Focus digests use when none is given.
   *  Unset: `push` (the phone app) when channels.push is enabled, else
   *  `ntfy`, so upgrading never points notify at a channel that is off. */
  channel: z.string().optional(),
  /** Notify on these events */
  on: z.object({
    taskComplete: z.boolean().default(true),
    taskError: z.boolean().default(true),
    taskQueued: z.boolean().default(false),
  }).default({}),
  /** What `agentx notify` does on this machine when it delivers: a desktop
   *  banner and a system sound. macOS only; see src/notify/local.ts. */
  local: z.object({
    banner: z.boolean().default(true),
    sound: z.boolean().default(true),
    /** A name from /System/Library/Sounds, without the extension. */
    soundName: z.string().regex(/^[\w -]+$/).default("Glass"),
    volume: z.number().min(0).max(1).default(0.4),
    /** Image for the AgentX Helper icon on banners (.png, .jpg, .icns).
     *  Unset: the AgentX logo. Applied by `agentx desktop install`. */
    icon: z.string().optional(),
  }).default({}),
}).default({})

const screenRectSchema = z.object({
  x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
})

/** Screen capture for agents: how captures are cropped and scaled, how
 *  long they wait for the right moment, named regions, and the opt-in
 *  in-memory buffer. See src/computer-use/capture.ts. */
const screenSchema = z.object({
  /** Pixel budget for a captured frame; larger captures are downscaled. */
  maxPixels: z.number().int().positive().default(1_200_000),
  /** Longest a capture waits for a change or for the screen to settle. */
  timeoutMs: z.number().int().positive().default(5_000),
  /** Time between samples while waiting. */
  intervalMs: z.number().int().positive().default(100),
  /** Mean difference (0–1) above which two samples count as different. */
  changeThreshold: z.number().min(0).max(1).default(0.015),
  /** How long a region must stay unchanged to count as stable. */
  stableMs: z.number().int().nonnegative().default(400),
  /** Named regions in screen points, e.g. { "chat": { x, y, width, height } }.
   *  A name here overrides the built-in region of the same name. */
  regions: z.record(z.string().regex(/^[a-z][\w-]*$/), screenRectSchema).default({}),
  /** The last few seconds of a region, kept in memory by the daemon. Off
   *  unless enabled; frames are written out only when asked for. */
  buffer: z.object({
    enabled: z.boolean().default(false),
    seconds: z.number().positive().max(120).default(10),
    fps: z.number().positive().max(10).default(2),
    region: z.string().default("screen"),
    maxPixels: z.number().int().positive().default(300_000),
  }).default({}),
}).default({})

/** The Approvals inbox (src/approvals). Decision cards agents raise, and
 *  when the operator hears about what is waiting. */
export const requestsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Channels to capture on. Empty: every channel a person writes on
   *  (telegram, whatsapp, slack, discord, gitlab, github, app, voice,
   *  dashboard, webrtc). */
  channels: z.array(z.string().min(1)).default([]),
  /** Who counts as the owner on channels other people can reach, as
   *  "channel:id": the login on GitLab and GitHub, the sender id elsewhere.
   *  Usernames beside an id and display names are not matched. Empty: only
   *  this node's own surfaces (voice, app, dashboard, webrtc) are captured. */
  from: z.array(z.string().regex(/^[a-z0-9_-]+:\S+$/i, "use channel:id, for example telegram:123456789")).default([]),
  /** An open request with no activity for this long comes back to the owner. */
  staleAfterHours: z.number().positive().max(24 * 365).default(24),
  /** Closed requests are deleted after this many days. Open ones never are. */
  retentionDays: z.number().positive().max(3650).default(90),
  /** Tracked plans (src/requests/plans.ts, #788): a request with two or
   *  more steps, each with an owner agent, followed until every step is
   *  done. Needs `enabled` above. */
  plans: z.object({
    enabled: z.boolean().default(true),
    /** A step with no progress for this long gets a nudge. */
    stallMinutes: z.number().positive().max(7 * 24 * 60).default(30),
    /** Nudges per step before it counts as blocked and the owner is told. */
    maxNudges: z.number().int().min(0).max(20).default(3),
    /** Step kinds the owner approves once, when the plan is made. A
     *  "message" step is then sent without asking again. */
    approveKinds: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/, "a step kind: a short lower-case word")).default(["message"]),
    /** Agents that may not open a plan. */
    disabledAgents: z.array(z.string().min(1)).default([]),
  }).default({}),
}).default({})

/** People (src/people, #384): the humans who talk to the agents, one entry
 *  per person whatever channel they use. Empty: this machine's owner is the
 *  only known person and nothing else changes. */
export const personSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "lower-case letters, digits, - and _"),
  name: z.string().min(1).max(80),
  /** How this person's name is said aloud, e.g. "A-neess Ma-roo-shee"
   *  (#433). Written forms stay as they are; see voice.pronunciations. */
  say: z.string().trim().min(1).max(120).optional(),
  /** `client` (#453): someone the owner works for; /member shows them
   *  "Your project", not a teammate's "My work". */
  role: z.enum(["owner", "member", "client", "guest"]).default("member"),
  /** "channel:id": a GitLab or GitHub login, a Telegram id or username, a
   *  WhatsApp number. Display names are not matched. */
  identities: z.array(z.string().regex(/^[A-Za-z][\w-]*:\S.*$/, "write it as channel:id")).default([]),
  /** The agents this person may reach, by id. Empty: every agent (#379). */
  agents: z.array(z.string().min(1)).default([]),
  /** What this person's turns may not use (#379), enforced by a per-run
   *  guard hook. Names match without case; `*` is a wildcard. Empty: no
   *  limit. A further level is a new key here. */
  deny: z.object({
    /** Tool names: "Bash", "WebFetch", "mcp__mail__*". */
    tools: z.array(z.string().min(1)).default([]),
    /** Skill names, as the Skill tool and auto-injection name them. */
    skills: z.array(z.string().min(1)).default([]),
  }).strict().default({}),
})

export const peopleConfigSchema = z.array(personSchema).default([]).superRefine((people, ctx) => {
  const problem = peopleProblem(people)
  if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem })
})

/** Teammates' machines and their trail (src/members, #385, #379). */
export const membersConfigSchema = z.object({
  /** Days the per-person log (invites, pairings, sign-ins, refusals,
   *  removals) is kept. Older lines are dropped. */
  logRetentionDays: z.number().int().min(1).max(3650).default(90),
}).default({})

export const requestStatusConfigSchema = z.object({
  /** Channels that show it. On gitlab and github: one comment per request,
   *  kept up to date by the daemon. Empty: off. */
  channels: z.array(z.string().min(1)).default([]),
}).default({})

export const approvalsConfigSchema = z.object({
  /** A card without an `expires` gets this many days. */
  defaultExpiryDays: z.number().positive().max(365).default(3),
  /** No card waits longer than this, whatever the agent asked for. */
  maxExpiryDays: z.number().positive().max(365).default(30),
  /** How long "later" hides an item. */
  laterHours: z.number().positive().max(24 * 30).default(24),
  /** Tell the agent that raised a card when it is decided or expires. */
  notifyAgent: z.boolean().default(true),
  /** The mesh peer (`mesh.peers[].name`) whose inbox and popup take the
   *  cards agents on this node raise (#668). The result comes back here
   *  and reaches the agent. Unset: cards stay on this node. */
  forwardTo: z.string().min(1).optional(),
  /** At most one message a day: how many are waiting, and the most urgent. */
  digest: z.object({
    enabled: z.boolean().default(true),
    /** Local time, 24-hour HH:MM. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour").default("09:00"),
    /** IANA timezone for `time`. Unset: this machine's. */
    timezone: z.string().refine((tz) => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false }
    }, "unknown timezone").optional(),
    /** Where it goes. Unset: notifications.destination. */
    destination: z.object({
      channel: z.string(),
      chatId: z.string(),
      accountId: z.string().optional(),
    }).optional(),
  }).default({}),
  /** A popup on this Mac for new decision cards: sound, a spoken line,
   *  ready-made choices. Held during Focus. macOS only. */
  popup: z.object({
    enabled: z.boolean().default(false),
    /** "card": a small web window; "dialog": plain macOS dialogs. */
    style: z.enum(["card", "dialog"]).default("card"),
    /** The card's colours; "system" follows light or dark mode. */
    theme: z.enum(["system", "light", "dark"]).default("system"),
    /** Speak a short line when it opens. */
    speak: z.boolean().default(true),
    /** A macOS voice name for `say -v`. Unset: the system voice. */
    voice: z.string().regex(/^[\w .()-]+$/, "a voice name, as `say -v '?'` lists them").optional(),
    /** "chime" (a soft chime played by the card), a system sound from
     *  /System/Library/Sounds like Glass, or "" for none. */
    sound: z.string().regex(/^[\w -]*$/, "a sound name, like chime or Glass").default("chime"),
    volume: z.number().min(0).max(1).default(0.4),
    /** Seconds the popup waits for an answer; then the card stays in the inbox. */
    timeoutSeconds: z.number().int().min(10).max(3600).default(600),
  }).default({}),
  /** Check-ins (src/approvals/checkin.ts): a few times a day, waiting cards
   *  come back to the Mac card and the operator's open Apple Reminders get
   *  a card written by the agent that owns them. macOS only. */
  checkin: z.object({
    enabled: z.boolean().default(false),
    /** Local times of a normal pass: reminders due soon, and waiting cards. */
    times: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour")).default(["11:00", "14:00", "17:00"]),
    /** Local time of the daily pass: every open reminder. */
    dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour").default("09:00"),
    /** IANA timezone for the times. Unset: this machine's. */
    timezone: z.string().refine((tz) => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false }
    }, "unknown timezone").optional(),
    /** The operator's Reminders lists to look at. */
    lists: z.array(z.string().min(1)).default(["Reminders"]),
    /** Agent that writes cards for reminders without an agentx trailer. */
    agent: z.string().min(1).optional(),
    /** A normal pass takes reminders due within this many hours, or overdue. */
    dueWithinHours: z.number().positive().max(24 * 30).default(24),
    /** Most agents one pass asks to write a card, whatever they answer. */
    maxAsksPerPass: z.number().int().min(1).max(20).default(5),
    /** How long an agent may take to write one card, counted from the start
     *  of its turn. The turn is stopped at the limit. */
    composeTimeoutSeconds: z.number().int().min(30).max(3600).default(300),
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
  /** Wiki-wide settings (#824). */
  wiki: z.object({
    /** The daily per-agent contribution and the merge that applies it.
     *  Both jobs are added to the schedule when at least one agent has
     *  `wiki.contribute.enabled`; a cron with the same id overrides them. */
    contributions: z.object({
      /** When each enabled agent reviews its day (cron, 5 fields). */
      schedule: z.string().default("40 22 * * *"),
      /** When the queued patches are applied. */
      mergeSchedule: z.string().default("20 23 * * *"),
      timezone: z.string().default("UTC"),
      /** Default per-agent, per-run model spend cap in USD. */
      maxCostUsd: z.number().min(0).max(20).default(0.5),
      /** Default model for the contribution call. */
      model: z.string().default("sonnet"),
    }).default({}),
    query: z.object({
      /** `wiki query` also searches other agents' readable pages and the
       *  root wiki's own pages. */
      shared: z.boolean().default(true),
      /** How pages are picked (#855). `summaries`: from the one-line page
       *  summaries `agentx wiki summarize` writes, then a live read.
       *  `catalog`: from titles, then a walk along the pages' links.
       *  `auto`: `summaries` once most of the agent's own pages have a
       *  summary (AUTO_SUMMARY_COVERAGE in src/wiki/query.ts), `catalog`
       *  until then. */
      method: z.enum(["auto", "summaries", "catalog"]).default("auto"),
      /** The agent's own pages shown to the model that picks. */
      candidates: z.number().int().min(1).max(50).default(12),
      /** Other agents' pages shown beside them. */
      sharedCandidates: z.number().int().min(0).max(50).default(4),
      /** Most pages opened for one answer. */
      maxPages: z.number().int().min(1).max(10).default(3),
      /** Pages also opened along the `related` links of the picked pages
       *  (summaries method), in total. 0: none. */
      linkedPages: z.number().int().min(0).max(10).default(0),
      /** Characters of each opened page given to the answer. */
      pageChars: z.number().int().min(200).max(40_000).default(4000),
      /** Model that picks pages from the summary lines. */
      navigatorModel: z.string().min(1).default("haiku"),
      /** Model that writes the answer. */
      answerModel: z.string().min(1).default("sonnet"),
      /** Before the answer, confirm at the source what may have changed
       *  since the pages were written. A model names the reads; code runs
       *  them, and each is one HTTP GET. Nothing runs until `sources`
       *  lists where to read. */
      live: z.object({
        enabled: z.boolean().default(true),
        /** Most reads for one question. */
        maxReads: z.number().int().min(0).max(20).default(6),
        /** Timeout of one read, in milliseconds. */
        timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
        /** Model that names the reads. */
        plannerModel: z.string().min(1).default("haiku"),
        sources: z.array(wikiLiveSourceSchema).default([]),
      }).default({}),
    }).default({}),
    /** One-line page summaries `wiki query` picks pages from (#855). */
    summaries: z.object({
      model: z.string().min(1).default("haiku"),
      /** Pages per model call. */
      batchSize: z.number().int().min(1).max(50).default(20),
      /** Longest summary, in words. */
      maxWords: z.number().int().min(5).max(120).default(35),
      /** When `agentx wiki summarize` runs on its own (cron, 5 fields).
       *  Unset: no job is added. */
      schedule: z.string().refine((v) => v.trim() === "" || isCronExpression(v), "expected a cron of 5 fields, such as \"30 23 * * *\"").optional(),
      timezone: z.string().refine(isTimeZone, "expected a time zone such as \"UTC\" or \"Europe/Paris\"").default("UTC"),
      /** Agent the job is filed under. Unset: `node.defaultAgent`, else
       *  the first agent. */
      agent: z.string().min(1).optional(),
    }).default({}),
    /** The chat bubble on every wiki page: the owner types an instruction and
     *  an agent researches it and edits the open page. */
    curator: z.object({
      enabled: z.boolean().default(true),
      /** Agent that answers. Unset: the page's owner agent. */
      agent: z.string().min(1).optional(),
    }).default({}),
  }).default({}),
  channels: channelsConfigSchema.default({}),
  crons: z.record(z.string(), cronJobSchema).default({}),
  /** Notes agents leave for the wiki observe/sweep run (#825). */
  wikiNotes: wikiNotesSchema.default({}),
  services: z.record(z.string(), serviceSchema).default({}),
  notifications: notificationsSchema,
  calls: callsSchema,
  /** Watched WhatsApp chats triaged by an agent (src/whatsapp-triage). */
  whatsappTriage: whatsappTriageSchema,
  approvals: approvalsConfigSchema,
  /** How a daemon stop treats runs still in flight. */
  shutdown: z.object({
    /** Wait this long for runs to finish before cutting them off (they are
     *  then resumed or reported after the restart). Unset: the
     *  AGENTX_DRAIN_TIMEOUT_MS env var, else 300 s. Keep the service
     *  manager's stop timeout above it, or it kills the daemon mid-wait. */
    drainTimeoutSeconds: z.number().int().min(0).max(86_400).optional(),
    /** Who may ask for "restart when idle", and what happens to the others.
     *  Unset: any caller may, and onTimeout "restart" is honoured. */
    restart: z.object({
      /** Regular expression matched against the request's `by`. Requests
       *  from anyone else are held until `window`, or refused when there
       *  is no window. */
      allowBy: z.string().optional(),
      /** Local time "HH:MM" at which held requests start an idle-only wait. */
      window: z.string().regex(/^\d{1,2}:\d{2}$/, "window must be HH:MM").optional(),
      /** How long that wait lasts before it gives up. */
      windowWaitMinutes: z.number().int().min(1).max(1440).default(180),
      /** Turn every request into an idle-only one: a wait that runs out
       *  gives up instead of restarting over running work. */
      forbidOnTimeoutRestart: z.boolean().default(false),
    }).default({}),
  }).default({}),
  /** What happens to runs a restart cuts off (agents/resume). Chat messages
   *  are resumed in their chat; scheduled jobs never are (the next run
   *  covers them); everything else is reported unless its channel is in
   *  directChannels. */
  resume: z.object({
    enabled: z.boolean().default(true),
    /** Older runs are reported, not resumed. */
    maxAgeMinutes: z.number().int().positive().default(30),
    /** A run cut off while resuming is not retried past this. */
    maxAttempts: z.number().int().min(0).default(1),
    /** Channels whose runs are only reported, even from a chat. */
    reportOnlyChannels: z.array(z.string()).default([]),
    /** Non-chat runs (voice, agent-to-agent, webhooks…) resumed on these
     *  channels. Their answer isn't delivered anywhere; opt in only for
     *  runs whose work is the point. */
    directChannels: z.array(z.string()).default([]),
    /** This many restarts within the window pauses resuming. */
    crashLoop: z.object({
      restarts: z.number().int().positive().default(3),
      windowMinutes: z.number().positive().default(10),
    }).default({}),
  }).default({}),
  /** Stop and resume signals (agents/signals, #857): stop a running task
   *  cleanly, keep the agent's resume plan, resume it later. The owner may
   *  always signal; an agent may signal tasks it dispatched, or any task
   *  when listed in allowAgents; a mesh peer only when listed in allowPeers. */
  signals: z.object({
    enabled: z.boolean().default(true),
    /** How long the stopped agent gets to write its resume plan. Past it,
     *  the wind-down is stopped and a plan is built from the trace. */
    windDownSeconds: z.number().int().min(10).max(1800).default(120),
    /** Agents that may stop or resume any agent's task here ("*" for all). */
    allowAgents: z.array(z.string().min(1)).default([]),
    /** Mesh peers (node names) whose stop and resume signals are accepted. */
    allowPeers: z.array(z.string().min(1)).default([]),
    /** Loop brake: most signals one root id may carry in a day. */
    maxPerRoot: z.number().int().min(1).max(100).default(6),
  }).default({}),
  /** Open requests (src/requests, #356): what a person asked an agent for
   *  is recorded and followed until it is done, declined or dropped. Off
   *  by default. */
  requests: requestsConfigSchema,
  people: peopleConfigSchema,
  members: membersConfigSchema,
  /** Request status where the request was made (src/requests/status-board,
   *  #383): each person sees the state of their own request in the place
   *  they asked. Off by default. */
  requestStatus: requestStatusConfigSchema,
  /** Hand due Apple Reminders back to the agent that created them
   *  (src/reminders). macOS only; reads reminders whose notes end with the
   *  mac-pim skill's `agentx: agent=<id>` trailer. */
  reminders: z.object({
    enabled: z.boolean().default(false),
    /** Reminders lists to watch. */
    lists: z.array(z.string().min(1)).default(["AgentX"]),
    pollSeconds: z.number().int().min(15).default(60),
    /** Overdue by more than this (the daemon was down): reported, not run. */
    lookbackHours: z.number().positive().default(24),
    /** The remindctl binary, when it isn't on the daemon's PATH. */
    command: z.string().min(1).default("remindctl"),
  }).default({}),
  /** The phone app (/app) beyond pairing and notifications (#676). */
  app: z.object({
    /** The AgentX Android app (apps/android). Chrome shows it full screen,
     *  without an address bar, only when this computer vouches for it at
     *  /.well-known/assetlinks.json; with no fingerprints there is nothing
     *  to vouch for and that address answers 404. */
    android: z.object({
      /** applicationId the Android app was built with. */
      packageName: z.string().regex(/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/, "must look like com.example.app").default("dev.agentx.phone"),
      /** SHA-256 fingerprints of the key(s) that signed it, as AB:CD:… */
      certFingerprints: z.array(z.string().regex(/^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/, "must be 32 hex pairs separated by colons")).default([]),
    }).default({}),
    /** Place reminders: places the Android app watches as geofences, and
     *  what to do when the phone arrives or leaves (src/places). */
    places: z.object({
      enabled: z.boolean().default(true),
      /** Where places and their reminders are kept. Relative paths resolve
       *  from the folder holding agentx.json. */
      file: z.string().min(1).default(".agentx/places.json"),
      defaultRadiusMeters: z.number().int().min(50).max(50_000).default(150),
      /** Android rarely notices a smaller circle reliably. */
      minRadiusMeters: z.number().int().min(50).max(50_000).default(100),
      maxRadiusMeters: z.number().int().min(50).max(50_000).default(5000),
      /** Android lets one app watch at most 100 places. */
      maxPlaces: z.number().int().min(1).max(100).default(50),
      maxRulesPerPlace: z.number().int().min(1).max(50).default(10),
      /** A repeating reminder fires at most once in this window, so a
       *  phone hovering at the edge of a place doesn't buzz again and again. */
      cooldownMinutes: z.number().int().min(0).max(1440).default(10),
      /** A crossing the phone could only report later (no signal) is
       *  dropped once it is older than this. */
      maxEventAgeMinutes: z.number().int().min(1).max(1440).default(30),
      /** How often the Android app checks for changed places, in minutes.
       *  Android runs background checks at most every 15 minutes. */
      syncMinutes: z.number().int().min(15).max(1440).default(60),
    }).default({}),
  }).default({}),
  /** `agentx demo`, read from the agentx.json in the folder it runs from. */
  demo: z.object({
    /** Seconds each startup step (node /health, dashboard /live, mesh
     *  discovery) may take. Unset: AGENTX_DEMO_STARTUP_TIMEOUT, else 60 s
     *  scaled up by the load average (src/commands/demo-startup.ts). */
    startupTimeoutSeconds: z.number().int().positive().max(3600).optional(),
  }).default({}),
  /** The in-process event bus (src/events). `ringSize` bounds how many
   *  recent events GET /events/recent can return. */
  events: z.object({
    ringSize: z.number().int().min(1).max(100_000).default(1000),
  }).default({}),
  screen: screenSchema,
  mesh: meshConfigSchema.default({}),
  /** Voices for agents on mesh peers, keyed by remote agent id, or by
   *  "<peer>/<id>" for one peer's agent (it wins over the id). The Mac
   *  speaks for them, so their nodes need no ElevenLabs key. Unset fields
   *  are derived from the agent card; see src/voice/mesh-voice.ts. */
  meshVoices: z.record(z.string(), voiceSchema.omit({ rate: true, priority: true, hotkey: true }).extend({
    /** What to call the agent aloud, e.g. "Atlas" for "Main Agent". */
    name: z.string().optional(),
  })).default({}),
  /** How agents speak. The free system voices by default; ElevenLabs is an
   *  opt-in upgrade. Each agent's `voice` block can override the provider
   *  and pick its voice; see src/voice/agent-voice.ts. */
  voice: z.object({
    provider: voiceProviderSchema.default("system"),
    /** When ElevenLabs cannot speak (no key, an error): the system voice,
     *  or silence. */
    fallback: z.enum(["system", "none"]).default("system"),
    /** The system voice for agents without one of their own (see
     *  systemVoiceSchema). Unset: each agent gets its own. */
    system: systemVoiceSchema.optional(),
    /** Language for assigned system voices, e.g. "en", "fr-FR". */
    locale: z.string().default("en"),
    /** What agents call the person they talk with, e.g. a first name.
     *  Unset: "the user". */
    listener: z.string().optional(),
    /** How a word is said aloud without changing how it is written
     *  (#433): each pair's `written` form, matched as a whole word
     *  without case, is spoken as `spoken`. `languages` ("en", "fr",
     *  "ar") limits a pair to lines in those languages. Only speech
     *  changes; cards, transcripts and messages keep the written form.
     *  See src/voice/pronounce.ts. */
    pronunciations: z.array(z.object({
      written: z.string().trim().min(1).max(80),
      spoken: z.string().trim().min(1).max(120),
      languages: z.array(z.enum(["en", "fr", "ar"])).optional(),
    }).strict()).max(200).default([]),
    /** The agent's drawn pointer and name tag during a lesson. false: it
     *  is never drawn, and a lesson is spoken only. */
    pointer: z.boolean().default(true),
    /** AgentX Voice speech to text: "auto" uses ElevenLabs when a key is
     *  set and the local Whisper otherwise; "elevenlabs" or "local" pick
     *  one (ElevenLabs still falls back to local when it fails). */
    stt: z.enum(["auto", "elevenlabs", "local"]).default("auto"),
    /** Phone voice input where the daemon has no ffmpeg to measure a
     *  recording's length: refused by default, since the 2 MB cap alone
     *  lets through ~40 minutes of low-bitrate audio. true accepts it. */
    allowUnmeasured: z.boolean().default(false),
    /** Longest answer said aloud, in characters. A longer one stops at
     *  its last whole sentence inside this and says the rest is on
     *  screen; the written answer is always shown whole. The minimum
     *  keeps a cut answer over the 280 characters the Mac pill opens
     *  at (AnswerView.isWorthShowing), so "on screen" stays true. */
    spokenMaxChars: z.number().int().min(300).max(1500).default(SPOKEN_MAX_CHARS),
    /** A transcript with no words (empty, or only bracketed markers such
     *  as "[background noise]") gets a fixed reply from /ask and wakes no
     *  agent. `markers` is what counts as a marker, without the brackets. */
    noiseFilter: z.object({
      enabled: z.boolean().default(true),
      markers: z.array(z.string()).default(NOISE_MARKERS),
    }).default({}),
    /** The on-device engine behind "local" and every fallback:
     *  mlx-whisper (Python, all languages) or Parakeet (Core ML, 25
     *  European languages, no Arabic; 483 MB downloaded on first use into
     *  ~/.agentx/models). mlx-whisper answers until Parakeet is ready. */
    localStt: z.enum(["mlx-whisper", "parakeet"]).default("mlx-whisper"),
    /** How AgentX Voice hears the end of a hands-free turn: "vad" (Silero
     *  voice detection, 0.9 MB downloaded on first use; the volume
     *  threshold until then) or "volume" (the old fixed threshold). */
    endOfTurn: z.enum(["vad", "volume"]).default("vad"),
    /** AgentX Voice shortcuts: hold `talk` to speak, `stop` silences every
     *  voice, `paste` is smart paste. */
    hotkeys: z.object({
      talk: hotkeySchema.default(DEFAULT_HOTKEYS.talk),
      stop: hotkeySchema.default(DEFAULT_HOTKEYS.stop),
      paste: hotkeySchema.default(DEFAULT_HOTKEYS.paste),
    }).default({}),
    /** What shows the assistant's state in AgentX Voice: the "orb" at
     *  the pill's head, or the "character", the orb grown into a small
     *  creature that hovers above the bottom edge of the screen. */
    look: z.enum(VOICE_LOOKS).default("orb"),
    /** AgentX Voice starts with its pill reduced to the orb alone: a
     *  small circle the person can drag. Off: the full pill. */
    startReduced: z.boolean().default(false),
    /** The character takes a slow stroll beside where it rests when it
     *  has nothing to do. Off: it moves only out of the pointer's way. */
    stroll: z.boolean().default(false),
    /** How often the character plays a small animation by itself when
     *  it has nothing to do: a look around, a hop, a sway, and a yawn
     *  before it dozes. "off": none. */
    animations: z.enum(VOICE_ANIMATIONS).default("sometimes"),
    /** The orb and character palette of an agent that set neither
     *  presence.palette nor presence.color. */
    palette: z.enum(ORB_PALETTE_IDS).default(DEFAULT_PALETTE),
    /** The answer text AgentX Voice shows inside its pill. */
    card: z.object({
      /** Seconds the answer stays open once it has been spoken; 0 keeps
       *  it open until closed. */
      timeout: z.number().min(0).max(600).default(30),
      /** Tallest the answer grows, in points, before it scrolls. */
      maxHeight: z.number().min(120).max(800).default(320),
    }).default({}),
  }).default({}),
  business: businessConfigSchema.optional(),
  boards: boardsConfigSchema,
  dashboard: dashboardConfigSchema,
  graph: graphConfigSchema,
  decisions: decisionsConfigSchema,
  /** Workflow engine — declarative state machines that bind channel events
   *  to agents. Off by default; existing installs see no change until
   *  flipped. Definitions live under `dir` (default .agentx/workflows/). */
  workflows: z.object({
    enabled: z.boolean().default(false),
    dir: z.string().default(".agentx/workflows"),
    /** n8n keeps its several hundred connectors; we keep the agents. Point
     *  this at your n8n and the workflow builder lists YOUR n8n workflows as
     *  steps, so nobody has to copy a webhook URL by hand. */
    n8n: z.object({
      baseUrl: z.string().default(""),
      apiKey: z.string().default(""),
    }).default({ baseUrl: "", apiKey: "" }),
    matching: z.object({
      enabled: z.boolean().default(false),
      mode: z.enum(["suggest", "auto"]).default("suggest"),
      autoRunThreshold: z.number().min(0).max(1).default(0.85),
      suggestThreshold: z.number().min(0).max(1).default(0.65),
    }).default({}),
    /** Follow-up workflows (#788): agents start a saved workflow for a
     *  request, or build one from the owner's words, and the engine
     *  follows each step to the end. */
    followUp: z.object({
      /** Agents get agentx_workflow and the hint naming a saved workflow
       *  that fits the request. */
      enabled: z.boolean().default(true),
      /** Per agent, by id: false turns it off for that agent. */
      agents: z.record(z.boolean()).default({}),
      /** An agent step with no progress for this long gets a reminder. */
      stallMinutes: z.number().positive().max(7 * 24 * 60).default(30),
      /** Reminders before the step counts as blocked and you are told. */
      maxNudges: z.number().int().min(0).max(20).default(2),
      /** When you approve messages to people: all at once when a run
       *  starts ("start"), or each before it is sent ("step"). A workflow
       *  can set its own `approval`. */
      approval: z.enum(["start", "step"]).default("step"),
    }).default({}),
    /** Run every task through a workflow (#858): a saved workflow that
     *  fits, else a plan the agent writes first, else the one-step
     *  `linear` template. Needs `enabled`. Off by default. */
    required: z.object({
      enabled: z.boolean().default(false),
      /** Per agent, by id: true or false wins over `enabled`. */
      agents: z.record(z.boolean()).default({}),
      /** A plain question answered in one turn, with no plan and only tools
       *  that change nothing, leaves no run. On by default: such a turn has
       *  nothing to follow up. */
      exemptQuestions: z.boolean().default(true),
      /** Finished task runs kept (#877): one run per task adds up. The
       *  daemon removes the rest at start and once a day. Running and
       *  paused runs, and runs of saved workflows, are never removed. */
      retention: z.object({
        maxRuns: z.number().int().min(1).max(1_000_000).default(2000),
        maxDays: z.number().positive().max(3650).default(30),
      }).default({}),
    }).default({}),
    /** Controls whether the dashboard exposes the visual editor. "readonly"
     *  serves the list + run timelines but strips write controls from the
     *  page. "disabled" hides the tab entirely. */
    editor: z.enum(["disabled", "readonly", "edit"]).default("edit"),
  }).default({}),
  /** Procedures — user-perspective SOPs mined from recurring activity.
   *  The extraction cadence itself lives in `crons.procedure-extract`
   *  (written by `agentx procedure watch`); this block holds the miner's
   *  thresholds and the injection gates the daemon reads. */
  procedures: z.object({
    enabled: z.boolean().default(true),
    dir: z.string().default(".agentx/procedures"),
    extraction: z.object({
      enabled: z.boolean().default(false),
      /** Count patterns live after each completed task (no LLM cost). */
      onTaskCompletion: z.boolean().default(false),
      minOccurrences: z.number().int().min(2).default(3),
      sinceDays: z.number().int().min(1).default(7),
      maxClusters: z.number().int().min(1).default(5),
      /** Agent whose session distills drafts (LLM path). */
      via: z.string().optional(),
    }).default({}),
    /** Inject matching procedures into fresh agent sessions as guidance. */
    injection: z.object({
      enabled: z.boolean().default(true),
      maxProcedures: z.number().int().min(1).default(2),
      minScore: z.number().min(0).max(1).default(0.5),
    }).default({}),
  }).default({}),
  /** Registered inbound webhooks — an inventory the dashboard manages. Each
   *  entry binds an (agent, source) pair to an optional signing secret. The
   *  actual inbound URL is always POST /webhook/<agentId>/<source>. */
  webhooks: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "webhook id must be lowercase slug"),
    // Open-string source — runtime + admin-panel + CLI all share a
    // canonical list (kept in sync via WEBHOOK_SOURCES). Loosened from a
    // strict enum so adding a new first-class service (the 5-step recipe)
    // doesn't require a schema bump in three places. Doctor + admin
    // validator still gate writes on the canonical list.
    source: z.string().min(1),
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
   *  session and rebuild the prompt from scratch. Every rotation captures a
   *  continuity memo that's injected into the chat's next fresh session.
   *  - `staleMinutes`: idle timeout before rotation. 12 h default — chat
   *    conversations must survive a workday's pauses; overnight silence
   *    starts fresh.
   *  - `maxTurnsPerSession`: backstop cap on turns per Claude session.
   *    Size-based rotation measures real context now, so this rarely fires
   *    first.
   *  - `tierTwoThresholdTokens`: rotate when the prior turn's END-OF-TURN
   *    per-request context (last API call's input + cacheRead + cacheCreate)
   *    reaches this. Claude bills the 1.5× long-context rate above 200K
   *    per REQUEST — 180K leaves headroom. NOT the cumulative turn total:
   *    that sums cache reads across every call and reads 10-20× too high. */
  session: z.object({
    staleMinutes: z.number().int().min(1).max(1440).default(720),
    maxTurnsPerSession: z.number().int().min(2).max(200).default(40),
    tierTwoThresholdTokens: z.number().int().min(50_000).max(200_000).default(180_000),
    /** Per-channel context rotation limits; omitted channels use the global limit. */
    tierTwoThresholdTokensByChannel: z.record(z.number().int().min(50_000).max(200_000)).default({}),
    /** Context assembly strategy:
     *  - "layered" (default): the classic stacked layers — session history,
     *    memory, cross-chat, wiki hint all appended every turn.
     *  - "planner": a Haiku pre-call decides what to retrieve before the
     *    main agent runs. Always-on core is kept (channel/scope/landscape/
     *    identity/intent + last 3 turns verbatim); history blob, wiki hint,
     *    and cross-chat are replaced by planner-selected bundles. Per-task
     *    overrides via AgentTask.contextStrategy for A/B benchmarking. */
    contextStrategy: z.enum(["layered", "planner"]).default("layered"),
    /** Optional hard ceilings on new claude-code runs across the fleet (all
     *  claude-code agents share one Claude subscription, so one counter).
     *  The plan's own limit is read from Claude Code's rate_limit_event and
     *  gates cold dispatches on its own; these caps sit on top for operators
     *  who want a local ceiling. Unset or 0 = off. Warm sessions always go
     *  through. Changing them applies on save, no restart. */
    maxClaudeCodeDispatchesPerHour: z.number().int().min(0).max(10_000).optional(),
    maxClaudeCodeDispatchesPer5h: z.number().int().min(0).max(50_000).optional(),
    /** How many requests BEFORE the immediate predecessor to show the
     *  session-continuity seat. 0 keeps today's two-message state exactly.
     *
     *  Off by default on purpose. A probe over 27 hand-written turns found
     *  that at 3, the seat's safety question (`needsHistory`) becomes
     *  cleanly separable where two messages leave it straddling zero — but
     *  that rests on 7 positive examples from synthetic scenarios, and this
     *  seat's failure mode is the agent silently losing conversation
     *  context. The promotion gate for that wants labelled production rows,
     *  not a good afternoon on a fixture. Raise it to collect them. */
    continuityStateTurns: z.number().int().min(0).max(5).default(0),
    /** How much a session is given when it starts, per channel (#615).
     *  `full` is the classic start. `lean` starts Claude Code with only
     *  the `agentx` MCP server (no user-level connectors), only the
     *  project's settings (no global CLAUDE.md, user skills or plugins),
     *  and asks for the landscape, chat history and cross-chat context
     *  through MCP tools instead of pushing them into the prompt. A
     *  channel missing here keeps the built-in default: github, a2a,
     *  workflow and cron are lean; every other channel is full. Only
     *  claude-code and codex-cli agents have a lean start; other tiers
     *  are always full. See src/agents/session-profile.ts. */
    profileByChannel: z.record(z.enum(["full", "lean"])).default({}),
    /** What a lean start keeps. */
    lean: z.object({
      /** MCP servers from the workspace's .mcp.json kept in a lean
       *  session, by name. `agentx` is always added. */
      mcpServers: z.array(z.string().min(1)).default(["agentx"]),
      /** Claude Code setting sources a lean session reads. Without `user`,
       *  the global CLAUDE.md, user skills, plugins and user-level MCP
       *  connectors are not loaded. `project` is the workspace. */
      settingSources: z.array(z.enum(["user", "project", "local"])).default(["project", "local"]),
      /** Replace the pushed landscape, chat history and cross-chat
       *  context with one line naming the tools that fetch them. */
      contextOnDemand: z.boolean().default(true),
      /** Built-in Claude Code tools a lean session gets, passed as
       *  `--tools` next to `--strict-mcp-config` (#615). Empty, the
       *  default, keeps every built-in tool. The tool schemas are about
       *  14k tokens of a first turn, so a short list is what brings a lean
       *  start under 20k; an agent that lacks a tool it needs fails
       *  mid-task, so this stays opt-in. The agentx MCP tools are not
       *  affected: ToolSearch is always added to the list, so they stay
       *  deferred. claude-code agents only. */
      tools: z.array(z.string().min(1)).default([]),
      /** The same per channel; a channel's non-empty list wins over
       *  `tools`. */
      toolsByChannel: z.record(z.array(z.string().min(1))).default({}),
      /** The `agentx_` MCP tools a lean session lists (#699). Empty, the
       *  default, lists every agentx tool. Claude Code already defers
       *  them while ToolSearch is available, so a list saves only their
       *  names (about 300 tokens) unless tool search is off. A tool left
       *  off cannot be found even through ToolSearch. `agentx_approval`,
       *  `agentx_request`, `agentx_events`, `agentx_attach_next` and
       *  `agentx_workflow` are always kept, and so are `agentx_agents`, `agentx_recent` and
       *  `agentx_wiki_query` while `contextOnDemand` is on. A name that is
       *  not an agentx tool is rejected, so a typo cannot silently drop a
       *  reply tool. Only an agentx server started as a command (stdio)
       *  can be told; an http entry lists every tool. claude-code agents
       *  only. */
      agentxTools: agentxToolListSchema.default([]),
      /** The same per channel; a channel's non-empty list wins over
       *  `agentxTools`. */
      agentxToolsByChannel: z.record(agentxToolListSchema).default({}),
    }).default({}),
    /** A cheaper model for runs started only by triage events (#615): a
     *  GitHub label added or removed, an issue or PR closed. A run that
     *  collapsed any other action ("opened, labeled") keeps the agent's
     *  model, and so does a follow-up whose session ran within the last
     *  hour (swapping models drops the prompt cache). A model set on the
     *  task itself, such as a cron job's, wins. Off until a model is set
     *  for the agent's engine. See triageModelFor in src/agents/routing.ts. */
    triage: z.object({
      /** The model per CLI engine: a Claude model for claude-code agents,
       *  an OpenAI model for codex-cli agents. Unset: no triage model. */
      models: z.object({
        "claude-code": z.string().min(1).optional(),
        "codex-cli": z.string().min(1).optional(),
      }).default({}),
      /** Event actions that count as triage. An action only reaches an
       *  agent when `channels.github.issueActions` /
       *  `pullRequestActions` (or a project rule) let it through. */
      actions: z.array(z.string().min(1)).default(["labeled", "unlabeled", "closed"]),
    }).default({}),
    /** Longest the agent-memory index (MEMORY.md) may be where it is
     *  loaded on every session: merged into each workspace's CLAUDE.md
     *  and inlined in the system prompt (#615). 0, the default, keeps the
     *  whole index. Cut whole lines only; a closing line counts the
     *  entries left out and points at `.agentx-memory.md`, which always
     *  holds the full index, and at `agentx memory index`. Applies to the
     *  prompt on save; the CLAUDE.md block follows at the next daemon
     *  start or memory change. */
    memoryIndexMaxChars: z.number().int().min(0).max(200_000).default(0),
    /** Resume or start fresh (#621, step 3). Before a claude-code session
     *  is resumed, compare what the coming turn costs when it replays the
     *  transcript with what a fresh lean start costs, and start fresh when
     *  that is cheaper by `margin`. Runs after the stale, tier-2 and
     *  max-turns rules and can only rotate earlier than they would.
     *  `shadow` only logs what it would do. Off by default. Applies on
     *  save. See src/agents/resume-gate.ts. */
    resumeGate: z.object({
      mode: z.enum(["off", "shadow", "active"]).default("off"),
      /** Tokens a fresh lean session starts with (~27k measured in #615). */
      freshTokens: z.number().int().min(1000).max(200_000).default(30_000),
      /** How long the cached transcript is assumed to survive. Longer is the
       *  safe side: it treats more sessions as warm, and keeps them. */
      cacheTtlMinutes: z.number().int().min(1).max(1440).default(60),
      /** Cache-write price as a multiple of the input price (2 for the
       *  one-hour cache, 1.25 for the five-minute one). */
      cacheWriteFactor: z.number().min(1).max(4).default(2),
      /** A fresh start must be at least this many times cheaper. */
      margin: z.number().min(1).max(10).default(1.5),
    }).default({}),
    /** ObservationPack (#621). A large tool result stays in the context
     *  and is re-read on every later request. With this on, a Claude Code
     *  PostToolUse hook saves a text result over `limitBytes` to
     *  `.agentx/observations/<agent id>/` and shows the model its first and last
     *  bytes plus the path of the saved original, which it can Read or
     *  grep. Off by default. claude-code agents only. Turning it on, or
     *  changing `tools`, takes a daemon restart (the hook is written into
     *  each workspace's .claude/settings.json at start); turning it off
     *  applies on save. See src/agents/observation-pack.ts. */
    observationPack: z.object({
      enabled: z.boolean().default(false),
      /** A text result larger than this many bytes is packed. */
      limitBytes: z.number().int().min(1024).max(1_048_576).default(10_240),
      /** Bytes of the start and of the end of the original the model sees. */
      headBytes: z.number().int().min(0).max(65_536).default(1024),
      tailBytes: z.number().int().min(0).max(65_536).default(1024),
      /** Tools the pack applies to. Each entry must match the whole tool
       *  name and may be a regular expression. `Read` is in by default
       *  (owner decision on #621, 2026-10-05): a file read over the limit
       *  is cut to its first and last lines, with the file's own path and
       *  line numbers, and the agent reads the lines it needs again with
       *  offset and limit. No copy of the file is saved. Take `Read` out
       *  of the list for an agent that edits large files all day. */
      tools: z.array(z.string().min(1)).default(["Bash", "Grep", "Read", "WebFetch", "mcp__.*"]),
      /** Days a saved original is kept. 0 keeps every original. */
      retentionDays: z.number().int().min(0).max(3650).default(0),
    }).default({}),
  }).default({}),
  /** Move B — JS/TS plugins. Each entry is an installed npm package name
   *  (e.g. `agentx-plugin-mattermost` or `@acme/plugin-mattermost`); the
   *  loader does a dynamic `import(name)` at boot, validates the manifest,
   *  and calls plugin.setup(ctx). Plugins can register channel adapters
   *  via ctx.addChannel() and subscribe to bus events via ctx.on(). Empty
   *  default — installs that don't list plugins are unaffected. Plugin
   *  authoring guide: docs/architecture/plugins.md. */
  plugins: z.array(z.string()).default([]),
  /** Persistent-process pool eviction knobs (handoff #8). The pool keeps
   *  one warm Claude subprocess per (agent, channel, chatId) so latency
   *  stays low; without bounds, an idle process can serve traffic days
   *  later with stale context. These knobs cap that risk. All values are
   *  in seconds for operator-friendliness; the registry uses ms internally.
   *
   *  - `maxIdleSeconds`: a handle becomes eligible for cap-pressured
   *    eviction this many seconds after its last turn. Default 30s
   *    (matches the registry's pre-config behavior).
   *  - `maxAgeSeconds`: a handle is killed unconditionally on the next
   *    sweep once its total wall-clock idleness exceeds this. Default
   *    2700s (45min) — matches the registry's pre-config staleTimeoutMs.
   *  - `sweepIntervalSeconds`: how often the sweeper checks. Default 5s.
   *
   *  See `agents.<id>.persistentProcess` to opt an agent into the pool. */
  processPool: z.object({
    maxIdleSeconds: z.number().int().min(5).max(86_400).default(30),
    maxAgeSeconds: z.number().int().min(60).max(86_400).default(2700),
    sweepIntervalSeconds: z.number().int().min(1).max(300).default(5),
  }).default({}),
})

export type DaemonConfig = z.infer<typeof daemonConfigSchema>
export type AgentDef = z.infer<typeof agentConfigSchema>
export type EventSubscription = z.infer<typeof eventSubscriptionSchema>
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

  return withSummariesJob(withContributionJobs(result.data))
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
    if (!["claude-code", "codex-cli", "opencode"].includes(agent.tier) && (!providerConfig || !providerConfig.apiKey)) {
      warnings.push(
        `Agent "${id}": provider "${providerName}" has no API key configured. ` +
          `Set providers.${providerName}.apiKey in config or use a CLI-backed tier ("claude-code", "codex-cli", or "opencode").`
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

/** Cron ids of the daily wiki contribution jobs. */
export const WIKI_CONTRIBUTE_JOB = "wiki-contribute"
export const WIKI_CONTRIBUTE_MERGE_JOB = "wiki-contribute-merge"

/**
 * Add the daily wiki contribution and merge jobs when an agent has
 * `wiki.contribute.enabled` (#824), so they show and run with the other
 * schedules. A cron the operator defined under the same id wins. The
 * commands call the CLI of the running release, so an upgrade needs no
 * edit.
 */
export function withContributionJobs(config: DaemonConfig, cli: string = agentxCli()): DaemonConfig {
  const enabled = Object.entries(config.agents).filter(([, a]) => a.wiki?.contribute?.enabled).map(([id]) => id).sort()
  if (enabled.length === 0) return config
  const c = config.wiki.contributions
  const job = (schedule: string, command: string) => cronJobSchema.parse({
    schedule, timezone: c.timezone, agent: enabled[0], command, timeout: 3600, onError: "log",
  })
  const generated: Record<string, z.infer<typeof cronJobSchema>> = {
    [WIKI_CONTRIBUTE_JOB]: job(c.schedule, `${cli} wiki contribute --all`),
    [WIKI_CONTRIBUTE_MERGE_JOB]: job(c.mergeSchedule, `${cli} wiki contributions merge`),
  }
  return { ...config, crons: { ...generated, ...config.crons } }
}

/** Cron id of the job that keeps the wiki page summaries current. */
export const WIKI_SUMMARIZE_JOB = "wiki-summarize"

/**
 * Add the job that keeps the page summaries current when
 * `wiki.summaries.schedule` is set (#855). It only spends on pages that
 * are new or changed. A cron the operator defined under the same id wins.
 */
export function withSummariesJob(config: DaemonConfig, cli: string = agentxCli()): DaemonConfig {
  const s = config.wiki.summaries
  const agent = s.agent ?? config.node.defaultAgent ?? Object.keys(config.agents).sort()[0]
  if (!s.schedule?.trim() || !agent) return config
  const job = cronJobSchema.safeParse({
    schedule: s.schedule, timezone: s.timezone, agent, command: `${cli} wiki summarize --all`, timeout: 3600, onError: "log",
  })
  if (!job.success) {
    throw new Error(`wiki.summaries: the ${WIKI_SUMMARIZE_JOB} job can't be built: ${job.error.issues.map((i) => i.message).join("; ")}`)
  }
  return { ...config, crons: { [WIKI_SUMMARIZE_JOB]: job.data, ...config.crons } }
}

/** How to call this release's CLI from a shell. */
function agentxCli(): string {
  const entry = process.argv[1] ?? ""
  if (/[\\/]cli\.(?:c|m)?js$/.test(entry)) return `"${process.execPath}" "${entry}"`
  return "agentx"
}
