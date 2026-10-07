import { createAgentContext } from "@/agent"
import { detectTechStack, formatTechStack } from "@/agent/context/tech-stack"
import { detectSchemas, formatSchemas } from "@/agent/context/schema"
import { loadLocalSkills, matchSkillsToTask } from "@/agent/skills/loader"
import { resolveOutputType } from "@/agent/outputs/types"
import { generate } from "@/agent"
import type { OutputType } from "@/agent/providers/types"
import { existsSync, readFileSync } from "fs"
import { describeQueue } from "@/daemon/voice-queue-api"
import type { QueueView } from "@/voice/speaking-queue"
import { resolve } from "path"
import { callerHeaders } from "@/calls/service"
import { READ_TOOL_NAMES, type McpToolSet } from "./tool-names"

// --- MCP Server: expose agentx as a Model Context Protocol server ---
// This allows Claude Code, Cursor, Windsurf, and any MCP client to use
// agentx's capabilities as tools.

// JSON-RPC types
interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number | string
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: Record<string, unknown>
}

// MCP protocol constants
const SERVER_INFO = {
  name: "agentx",
  version: "0.1.0",
}

/** The protocol versions this server speaks, oldest first. `initialize`
 *  answers with the client's version when it is one of these, and with
 *  the fallback otherwise (#794). */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]
const FALLBACK_PROTOCOL_VERSION = "2024-11-05"

export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : FALLBACK_PROTOCOL_VERSION
}

const CAPABILITIES = {
  tools: {},
  elicitation: { form: {} },
}

/** Counter for elicitation request IDs */
let elicitationIdCounter = 0

/**
 * Request information from the user via MCP elicitation.
 * Returns the user's response or null if declined/cancelled.
 */
async function elicit(
  message: string,
  schema: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const id = ++elicitationIdCounter

  // Send elicitation request (server → client)
  send({
    jsonrpc: "2.0",
    id: `elicit-${id}`,
    method: "elicitation/create",
    params: {
      mode: "form",
      message,
      requestedSchema: schema,
    },
  } as any)

  // Wait for response (blocking — MCP is request/response)
  return new Promise((resolve) => {
    elicitationResolvers.set(`elicit-${id}`, (result: any) => {
      if (result?.action === "accept" && result.content) {
        resolve(result.content)
      } else {
        resolve(null)
      }
    })

    // Timeout after 60s
    setTimeout(() => {
      if (elicitationResolvers.has(`elicit-${id}`)) {
        elicitationResolvers.delete(`elicit-${id}`)
        resolve(null)
      }
    }, 60_000)
  })
}

/** Pending elicitation response handlers */
const elicitationResolvers = new Map<string, (result: any) => void>()

// --- Where the daemon is listening ---
//
// This used to be a hardcoded `http://localhost:19900`, which is one node's
// port, not a universal default. Every daemon-backed tool here (channel.reply,
// send, task, crons, …) failed with a bare "fetch failed" on any node bound
// elsewhere — the agent sees a dead tool and no reason why.
//
// The server already knows: `serve --stdio --cwd <dir>` chdirs into the
// agentx install, so the same agentx.json the daemon booted from is readable
// right here. Resolution order:
//
//   1. AGENTX_DAEMON_URL      — explicit wins, incl. pointing at a remote node
//   2. node.bind in the config — what the daemon is actually listening on
//   3. localhost:18800         — last-resort default, the daemon's own
//                                default port (#794)
//
// Resolved lazily and memoized: this module is imported before
// commands/serve.ts applies `process.chdir(--cwd)`, so reading the config at
// import time would look in the wrong directory.
const DEFAULT_DAEMON_URL = "http://localhost:18800"

let daemonUrlCache: string | undefined

function resolveDaemonUrl(): string {
  if (process.env.AGENTX_DAEMON_URL) return process.env.AGENTX_DAEMON_URL
  // Read the raw config rather than going through loadDaemonConfig(): the
  // only field needed is node.bind, and a schema failure somewhere else in
  // the file must not cost every tool its daemon connection.
  for (const rel of ["agentx.json", ".agentx/config.json"]) {
    try {
      const path = resolve(process.cwd(), rel)
      if (!existsSync(path)) continue
      const bind = JSON.parse(readFileSync(path, "utf-8"))?.node?.bind
      if (typeof bind !== "string" || !bind.includes(":")) continue
      {
        const idx = bind.lastIndexOf(":")
        const host = bind.slice(0, idx)
        const port = bind.slice(idx + 1)
        // 0.0.0.0 / :: are bind-side wildcards, not dialable addresses.
        const dialable = !host || host === "0.0.0.0" || host === "::" || host === "*"
          ? "127.0.0.1"
          : host
        if (port) return `http://${dialable}:${port}`
      }
    } catch { /* unreadable or unparseable — try the next candidate */ }
  }
  return DEFAULT_DAEMON_URL
}

function daemonUrl(): string {
  if (daemonUrlCache === undefined) daemonUrlCache = resolveDaemonUrl()
  return daemonUrlCache
}

// --- The token every daemon call carries (#794) ---
//
// Loopback callers pass the daemon's mesh gate without one, but a node
// reached through AGENTX_DAEMON_URL, or one that gates a route for every
// caller, answers 401 to a call with no Authorization header. Resolution:
//
//   1. AGENTX_TOKEN            — explicit wins
//   2. MESH_TOKEN              — the environment, then the install's .env
//   3. dashboard.token         — from the same config the URL came from
//
// Memoized like the URL, for the same chdir reason.
let daemonTokenCache: string | undefined

function readDotEnvValue(key: string): string {
  try {
    const path = resolve(process.cwd(), ".env")
    if (!existsSync(path)) return ""
    for (const raw of readFileSync(path, "utf-8").split("\n")) {
      const line = raw.trim().replace(/^export\s+/, "")
      if (!line.startsWith(`${key}=`)) continue
      const value = line.slice(key.length + 1).trim()
      return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value
    }
  } catch { /* unreadable — no token from here */ }
  return ""
}

function resolveDaemonToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTX_TOKEN) return env.AGENTX_TOKEN
  if (env.MESH_TOKEN) return env.MESH_TOKEN
  const fromDotEnv = readDotEnvValue("MESH_TOKEN")
  if (fromDotEnv) return fromDotEnv
  for (const rel of ["agentx.json", ".agentx/config.json"]) {
    try {
      const path = resolve(process.cwd(), rel)
      if (!existsSync(path)) continue
      const token = JSON.parse(readFileSync(path, "utf-8"))?.dashboard?.token
      if (typeof token === "string" && token) return token
    } catch { /* try the next candidate */ }
  }
  return ""
}

function daemonToken(): string {
  if (daemonTokenCache === undefined) daemonTokenCache = resolveDaemonToken()
  return daemonTokenCache
}

/** `fetch` for daemon calls: adds `Authorization: Bearer <token>` when a
 *  token is known. A header the caller set itself is kept. */
const daemonFetch: typeof fetch = (input, init) => {
  const token = daemonToken()
  if (!token) return fetch(input, init)
  const headers = new Headers(init?.headers)
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`)
  return fetch(input, { ...init, headers })
}

/** Which running turn is delegating (#277). The AgentX runtime exports
 *  these to the processes an agent launches; the daemon uses them to find
 *  the caller's turn and, when a person started it, answer at once and
 *  call back later. Never taken from model-supplied arguments. */
export function callerFields(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  if (env.AGENTX_TASK_ID) out.callerTaskId = env.AGENTX_TASK_ID
  if (env.AGENTX_CHANNEL) out.callerChannel = env.AGENTX_CHANNEL
  if (env.AGENTX_CHAT_ID) out.callerChatId = env.AGENTX_CHAT_ID
  return out
}

/** The intent-graph path of the turn this process belongs to, from the
 *  daemon, with the configured retrieval weight. Undefined outside a
 *  running turn, before it is classified, or when the daemon is away. */
async function runningIntentPath(): Promise<{ path?: string[]; graphWeight?: number } | undefined> {
  const agent = process.env.AGENTX_AGENT_ID
  const caller = callerFields()
  if (!agent || !caller.callerChannel || !caller.callerChatId) return undefined
  try {
    const q = new URLSearchParams({ channel: caller.callerChannel, chatId: caller.callerChatId })
    const res = await daemonFetch(`${daemonUrl()}/agents/${encodeURIComponent(agent)}/intent-path?${q}`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { path?: string[] | null; graphWeight?: number }
    return {
      ...(Array.isArray(body.path) && body.path.length ? { path: body.path } : {}),
      ...(typeof body.graphWeight === "number" ? { graphWeight: body.graphWeight } : {}),
    }
  } catch {
    return undefined
  }
}

/** Test seams. `_reset…` drops the memoized value so a caller can change
 *  env/cwd; `_resolve…` exposes the uncached resolution itself. */
export function _resetDaemonUrlForTesting(): void {
  daemonUrlCache = undefined
  daemonTokenCache = undefined
}

export function _resolveDaemonUrlForTesting(): string {
  return resolveDaemonUrl()
}

export function _resolveDaemonTokenForTesting(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDaemonToken(env)
}

export const _daemonFetchForTesting = daemonFetch

// Strip ANSI escape codes from CLI output (we re-invoke the CLI for tools
// that shell out — chalk colors its output, MCP clients want plain text).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
function stripAnsi(s: string): string { return s.replace(ANSI_RE, "") }

/** agentx_recent without a chatId: the calling agent's own chats of today,
 *  newest first, grouped by chat. Stands in for the cross-chat context a
 *  lean session (#615) is not handed up front. */
async function recentAcrossChats(agent: string, channel: string | undefined, limit: number | undefined) {
  const res = await daemonFetch(`${daemonUrl()}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent, channel, limit: Math.min(Math.max(limit ?? 30, 1), 100) }),
  })
  const data = await res.json().catch(() => ({})) as any
  if (!res.ok) return { content: [{ type: "text" as const, text: `Error: ${data.error || res.statusText}` }] }
  const turns = (data.turns || []) as Array<{ ts: string; role: string; senderName: string; content: string; channel: string; chatId: string }>
  const scope = channel ? `on ${channel}` : "on any channel"
  if (turns.length === 0) return { content: [{ type: "text" as const, text: `No other messages ${scope} today for ${agent}.` }] }
  return { content: [{ type: "text" as const, text: renderTurnsByChat(turns, Boolean(data.hasMore)) }] }
}

/** Exported for tests. */
export function renderTurnsByChat(
  turns: Array<{ ts: string; role: string; senderName: string; content: string; channel: string; chatId: string }>,
  hasMore: boolean,
): string {
  const byChat = new Map<string, typeof turns>()
  for (const t of turns) {
    const key = `${t.channel}/${t.chatId}`
    if (!byChat.has(key)) byChat.set(key, [])
    byChat.get(key)!.push(t)
  }
  const blocks: string[] = []
  for (const [key, list] of byChat) {
    const lines = [...list].sort((a, b) => a.ts.localeCompare(b.ts)).map((t) => {
      const who = t.role === "agent" ? "you" : (t.senderName || "user")
      return `  [${t.ts.slice(11, 16)}] ${who}: ${t.content.slice(0, 300)}`
    })
    blocks.push(`From ${key}:\n${lines.join("\n")}`)
  }
  if (hasMore) blocks.push("[older turns exist — pass a chatId, or call /recall with before=<ts>]")
  return blocks.join("\n\n")
}

/** The landscape text an agent would have been given in its prompt. */
async function fetchLandscape(agent: string): Promise<string> {
  const res = await daemonFetch(`${daemonUrl()}/agents/${encodeURIComponent(agent)}/landscape`)
  const data = await res.json().catch(() => ({})) as any
  if (!res.ok) return `No landscape: ${data.error || res.statusText}`
  return (data.landscape as string) || `No landscape for ${agent}.`
}

/** Plain-text answer for agentx_events. Exported for tests. */
export function renderEventsAnswer(
  agentId: string,
  data: { subscriptions?: number; events?: any[]; next?: string },
  format: (e: any) => string,
): string {
  if (!data.subscriptions) return `${agentId} has no event subscriptions. Add agents.${agentId}.subscriptions to agentx.json to receive events.`
  const events = data.events ?? []
  if (events.length === 0) return `No new events match ${agentId}'s subscriptions.${data.next ? ` next: ${data.next}` : ""}`
  return [...events.map((e) => `- ${format(e)} [id ${e.id}, root ${e.rootId}]`), `next: ${data.next}`].join("\n")
}

// Tool definitions
const TOOLS = [
  {
    name: "agentx_generate",
    description:
      "Generate code, components, pages, APIs, documents, tests, workflows, schemas, emails, diagrams, and more using AI. Understands the project's tech stack, schemas, and skills automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description:
            "Describe what to generate (e.g., 'a responsive pricing card', 'REST API for users', 'GitHub Actions CI pipeline')",
        },
        type: {
          type: "string",
          description:
            "Output type: component, page, api, website, document, script, config, skill, media, report, test, workflow, schema, email, diagram, auto",
          default: "auto",
        },
        output_dir: {
          type: "string",
          description: "Optional output directory (relative to project root)",
        },
        cwd: {
          type: "string",
          description: "Project working directory (defaults to current directory)",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "agentx_inspect",
    description:
      "Analyze a project and return its tech stack, frameworks, databases, schemas, installed skills, and dependencies. Use this to understand a project before generating code.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cwd: {
          type: "string",
          description: "Project working directory (defaults to current directory)",
        },
      },
    },
  },
  {
    name: "agentx_skill_match",
    description:
      "Find installed skills that are relevant to a given task description. Returns matched skills with relevance scores.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "The task to match skills against",
        },
        cwd: {
          type: "string",
          description: "Project working directory",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "agentx_detect_output_type",
    description:
      "Auto-detect the best output type for a given task description based on keyword analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        task: {
          type: "string",
          description: "The task description to analyze",
        },
      },
      required: ["task"],
    },
  },

  // --- Daemon tools (require running daemon) ---

  {
    name: "agentx_channel_reply",
    description:
      "Reply to a channel (GitLab issue/MR comment, GitHub issue/PR comment, Telegram/WhatsApp message). PREFER THIS over raw curl/glab/HTTP — it auto-applies agent identity from agentMappings, the cascade-prevention marker, intent-ledger audit, and a 60s body-hash dedupe so an accidental retry within the window is a no-op. Returns the posted message id. For agent-to-agent delegation use agentx_send_agent. For arbitrary outbound sends use agentx_send.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string",
          description: "Channel name. gitlab | github | telegram | whatsapp | discord | slack",
        },
        chatId: {
          type: "string",
          description: "Stable chat id you received in this task's context. GitLab: 'org/repo:issue:123' or 'org/repo:merge_request:123'. GitHub: 'org/repo:issue:123' or 'org/repo:pull:123'. Telegram: numeric. WhatsApp: '+phone@s.whatsapp.net'.",
        },
        text: {
          type: "string",
          description: "Reply body. Markdown for gitlab/github/discord; plain for sms/whatsapp.",
        },
        agentId: {
          type: "string",
          description: "Optional posting identity. Defaults to channel-adapter resolution from agentMappings.",
        },
        accountId: {
          type: "string",
          description: "Multi-account adapters (telegram) need this when the chat is reachable from more than one bot.",
        },
        replyTo: {
          type: "string",
          description: "Optional reply-to message id for threaded channels.",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional explicit dedupe key. When omitted, a body hash is used. Use a stable key for 'overwrite my last status update' patterns.",
        },
      },
      required: ["channel", "chatId", "text"],
    },
  },
  {
    name: "agentx_channel_label",
    description:
      "Add and/or remove labels on a GitLab issue or merge_request through the canonical adapter (per-agent token, ledger). Use this instead of curl when changing labels on the entity that triggered the current task.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: { type: "string", description: "Currently 'gitlab'.", default: "gitlab" },
        project: { type: "string", description: "GitLab project path — 'org/repo'." },
        kind: { type: "string", description: "'issue' or 'merge_request'." },
        iid: { type: "string", description: "Numeric iid as a string." },
        add: { type: "array", items: { type: "string" }, description: "Labels to add." },
        remove: { type: "array", items: { type: "string" }, description: "Labels to remove." },
        agentId: { type: "string", description: "Optional posting identity." },
      },
      required: ["project", "kind", "iid"],
    },
  },
  {
    name: "agentx_send",
    description:
      "Low-level outbound send when you ALREADY have a channel-native chatId (Telegram numeric chat id, GitLab 'group/project:issue:123', WhatsApp '+phone@s.whatsapp.net'). For sending to another agent by name, use agentx_send_agent instead. For sending to a human contact by name, use agentx_send_contact instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string",
          description: "Target channel: telegram, whatsapp, gitlab, discord",
        },
        chatId: {
          type: "string",
          description: 'Chat ID. Telegram: numeric ("-1001234567890"). GitLab: "group/project:issue:123". WhatsApp: "+phone@s.whatsapp.net".',
        },
        text: {
          type: "string",
          description: "Message text to send",
        },
        agentId: {
          type: "string",
          description: "Agent ID to send as (determines bot account on Telegram, GitLab token, etc.)",
        },
      },
      required: ["channel", "chatId", "text"],
    },
  },
  {
    name: "agentx_send_agent",
    description:
      "Send a message to ANOTHER AGENT by exact agentId — uses the AgentX A2A mesh (or local registry when the agent lives on this daemon). This is the deterministic path for agent-to-agent communication; it never falls through to a contact lookup, so an unknown agentId returns 404 with the list of known agents instead of silently sending to a similarly-named human. Use this when the target is a registered agent. When a person started this conversation, the call returns at once with a task id; tell the person who you asked, end your turn, and the answer arrives later as a new message in this conversation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Exact agentId of the target agent (e.g. 'peer', 'atlas'). Must match an agent in this daemon's registry or in a healthy mesh peer's directory.",
        },
        text: {
          type: "string",
          description: "Message to send to the target agent",
        },
        senderAgentId: {
          type: "string",
          description: "Optional. The agentId on whose behalf this call is being made. Recorded in route_traces and (with A2A protocolVersion >= 2) validated by the receiving daemon.",
        },
      },
      required: ["agentId", "text"],
    },
  },
  {
    name: "agentx_recent",
    description:
      "Read the most recent messages from a chat across ALL agents that have sessions for it. Returns inbound + each agent's replies in chronological order, so you can see what's actually been said in a Telegram chat / GitLab thread / WhatsApp DM regardless of which agent recorded it. Use this BEFORE speculating about what was sent — the cx/devops/marketing thread on 2026-04-29 about a Marketing/CX bot mixup would have been resolved in one call instead of three agents speculating. Bounded by sinceISO (default: last 24h) and limit (default: 30, max: 200). " +
      "Without chatId: your own chats of today (all channels, or one when channel is given), newest first, grouped by chat — the cross-chat context a lean session is not handed up front.",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string",
          description: "Channel name. Examples: telegram, whatsapp, gitlab, github, discord, cron, api, a2a. Optional when chatId is omitted.",
        },
        chatId: {
          type: "string",
          description: "Channel-native chat id. Telegram: numeric (e.g. \"1816212449\" for a DM, \"-1001234567890\" for a group). GitLab: \"group/project:issue:123\". WhatsApp: \"+phone@s.whatsapp.net\". Omit to read across your own chats of today instead.",
        },
        agentId: {
          type: "string",
          description: "Whose chats to read when chatId is omitted. Ignored when the AgentX runtime already identifies you (AGENTX_AGENT_ID).",
        },
        sinceISO: {
          type: "string",
          description: "Optional ISO timestamp lower bound. Defaults to 24h ago.",
        },
        limit: {
          type: "number",
          description: "Optional cap on returned messages. Default 30, max 200.",
        },
      },
    },
  },
  {
    name: "agentx_events",
    description:
      "Read what happened on this node that matches your event subscriptions (agents.<id>.subscriptions in agentx.json): tasks other agents finished or failed, workflow runs, mesh hand-offs. " +
      "Use it to catch up after being idle instead of asking. Returns short summaries only (no prompts or answers), oldest first, at most 50. " +
      "Pass the `next` value from the previous answer as `since` to read only newer events.",
    inputSchema: {
      type: "object" as const,
      properties: {
        since: { type: "string", description: "An event id (events after it) or an ISO time. Default: the newest events in memory." },
        limit: { type: "number", description: "Most events to return. Default 20, max 50." },
        agentId: { type: "string", description: "Whose subscriptions to read. Ignored when the AgentX runtime already identifies you (AGENTX_AGENT_ID)." },
      },
    },
  },
  {
    name: "agentx_send_contact",
    description:
      "Send a message to a HUMAN CONTACT by name. Resolves through .agentx/contacts.json (id → exact alias → fuzzy substring). Refuses fuzzy matches without confirmed:true so the agent must ask the user to disambiguate before sending. Refuses when the name also matches a registered agent (use agentx_send_agent for those). Use this when the target is a person, not a bot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        contactName: {
          type: "string",
          description: "Free-form contact name. Tried as id first, then alias, then fuzzy substring.",
        },
        text: {
          type: "string",
          description: "Message to send to the contact",
        },
        channel: {
          type: "string",
          description: "Optional explicit channel (telegram | whatsapp | gitlab | discord). Defaults to the first channel configured for the contact.",
        },
        confirmed: {
          type: "boolean",
          description: "Pass true ONLY after the user has confirmed a fuzzy match. Without it, fuzzy matches return 409 with the candidate so you can ask the user.",
        },
        agentId: {
          type: "string",
          description: "Optional agent identity used for the outbound send (determines bot account / token).",
        },
      },
      required: ["contactName", "text"],
    },
  },
  {
    name: "agentx_task",
    description:
      "Send a task to a specific agent on the daemon. The agent processes it and returns a response. Use to delegate work to specialized agents. " +
      "When a person started this conversation, the call returns at once with a task id instead: tell the person who you asked and why, then end your turn. The answer arrives later as a new message in this same conversation.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Agent ID to send the task to",
        },
        message: {
          type: "string",
          description: "Task message for the agent",
        },
        senderAgentId: {
          type: "string",
          description: "Optional caller agent id. Defaults to AGENTX_AGENT_ID when the MCP server was launched by an AgentX runtime.",
        },
        freshSession: {
          type: "boolean",
          description: "Start the target agent with a clean AgentX-side conversation. Defaults to true for agent-to-agent delegation.",
        },
        chatId: {
          type: "string",
          description: "Optional stable chat/session id for this delegated task. Omit for a one-off isolated delegation.",
        },
      },
      required: ["agent", "message"],
    },
  },
  {
    name: "agentx_agents",
    description:
      "List all agents registered on the daemon with their status (active tasks, total tasks, errors, tier). " +
      "With landscape=true, also your landscape: the team on this node with handles and roles, agents on mesh peers, channels and the rules for working with them — what a lean session is not handed up front.",
    inputSchema: {
      type: "object" as const,
      properties: {
        landscape: {
          type: "boolean",
          description: "Also return the landscape text for the calling agent (AGENTX_AGENT_ID, or agentId).",
        },
        agentId: {
          type: "string",
          description: "Whose landscape to return when landscape=true. Ignored when the AgentX runtime already identifies you.",
        },
      },
    },
  },
  {
    name: "agentx_voice_queue",
    description:
      "See what this host is saying out loud and what waits to be said: every agent's spoken answers, narration, talks and lessons share one speaking queue. Use it before speaking at length, or when asked who is talking.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "agentx_call_owner",
    description:
      "Ring the owner for a live voice call on their desktop widget, when you need them directly and a message will not do. " +
      "When they answer you speak first, so give the reason in one line. Only agents the owner allowed (calls.allow) can call; " +
      "a few calls an hour at most. urgency 'urgent' rings through Focus: use it only for something that cannot wait. " +
      "Returns how it rang, or why it did not.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Why you are calling, in one line (at most 200 characters)." },
        urgency: { type: "string", enum: ["normal", "urgent"], description: "Default normal: held as a missed call during Focus." },
      },
      required: ["reason"],
    },
  },
  {
    name: "agentx_camera_ask",
    description:
      "Ask the owner to show you their phone camera, when you need to see something (a rack, a cable, a document). " +
      "The ask shows on their phone; the camera opens only if they tap Show. Same allowlist and hourly limit as calls (calls.allow). " +
      "Once they share, call agentx_camera_look for the newest picture. Returns whether the owner was told, or why not.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "What you want to see, in one line (at most 200 characters)." },
        urgency: { type: "string", enum: ["normal", "urgent"], description: "Default normal: held during Focus." },
      },
      required: ["reason"],
    },
  },
  {
    name: "agentx_camera_look",
    description:
      "The newest picture from the owner's phone camera while they share it with you, saved as a PNG. " +
      "Open the returned path with your Read tool to look at it. Fails when no share is live for you.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "agentx_health",
    description:
      "Get the daemon health status including node info, agents, crons, mesh peers, and uptime.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "agentx_attach_next",
    description:
      "Take the next message queued for the agent identity THIS session is attached to (attach mode). Returns the message plus who sent it and on which channel, or nothing when the inbox is empty. After calling this, just answer normally — your reply is captured automatically and sent back to the channel. Use when the user runs /inbox or asks you to check for waiting messages.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "agentx_attach_answer",
    description:
      "Explicitly answer the message currently claimed by this session (attach mode). Usually unnecessary — replying normally after agentx_attach_next is captured automatically. Use this only when your reply to the channel should differ from what you told the user in the terminal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "The reply to send back to the channel, verbatim.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "agentx_crons",
    description:
      "List cron jobs and their health. Shows healthy, failing, disabled counts and per-job status with consecutive error counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "agentx_schedule",
    description:
      "Manage recurring routines (schedules) in plain English. Actions: list, create, pause, resume, delete. " +
      "create and delete are REQUESTS: nothing takes effect until the operator approves (the operator is sent the parsed cron and next fire time). " +
      "Tell the user it is pending approval. You can pause/resume/delete only routines you created, unless you are an admin agent. " +
      "Example: {action:'create', when:'every monday at 10am', prompt:'Check the open invoices and summarise'}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "pause", "resume", "delete"],
          description: "What to do. Default: list.",
        },
        id: { type: "string", description: "Schedule id. Required for pause/resume/delete; optional for create (auto-generated)." },
        when: {
          type: "string",
          description: "create: plain-English timing, e.g. 'every monday at 10am', 'weekdays at 6pm', 'every 15 minutes', '1st of every month at noon'.",
        },
        prompt: { type: "string", description: "create: what the agent should do at each run." },
        agent: { type: "string", description: "create: agent that runs the routine. Default: you." },
        timezone: { type: "string", description: "create: IANA timezone. Default: the node's schedule default." },
        notify: {
          type: "string",
          description: "create: where results/failures go. 'here' (default: the current chat), 'none', or 'channel:chatId'.",
        },
        mine: { type: "boolean", description: "list: only routines you created." },
        channel: { type: "string", description: "Current chat's channel, from your task context. Used as the default notify target when the runtime didn't provide it." },
        chatId: { type: "string", description: "Current chat id, from your task context." },
        accountId: { type: "string", description: "Optional bot account for multi-account channels." },
        callerAgentId: { type: "string", description: "Your agent id. Ignored when the AgentX runtime already identifies you (AGENTX_AGENT_ID)." },
      },
    },
  },
  {
    name: "agentx_approval",
    description:
      "Ask the operator for a yes/no decision by raising a decision card in their Approvals inbox, instead of asking in chat. " +
      "Lead with your recommendation. Every card expires: say what should happen if nobody answers (if_silent). " +
      "You get a message with the result when it is decided or expires. You cannot approve anything with this tool. " +
      "Actions: create (default), status. " +
      "To offer ready-made answers, add choices (and optionally a draft message); the operator's pick and final text come back with the result. " +
      "Example: {title:'Publish the launch post draft', ask:'Publish the draft on Monday?', recommend:'Yes: it is reviewed and the date is agreed', if_silent:'discard', expires:'2d', source:'https://example.com/drafts/42'}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["create", "status"], description: "create (default) or status." },
        title: { type: "string", description: "create: what it is, in one line (max 120 characters)." },
        ask: { type: "string", description: "create: the yes/no question (max 300 characters)." },
        recommend: { type: "string", description: "create: your advice and why, in one line (max 300 characters). With choices, start with the exact label you advise: the Mac card marks it and opens with it picked." },
        if_silent: { type: "string", enum: ["discard", "keep", "pause"], description: "create: what applies if nobody answers before it expires. A card never approves itself: only the operator says yes." },
        expires: { type: "string", description: "create: when the default applies. ISO date/time, or relative like '12h' or '3d'. Default: the node's setting (3 days)." },
        source: { type: "string", description: "create: link to the draft, PR or issue." },
        choices: { type: "array", items: { type: "string" }, description: "create, optional: 1-5 ready-made answers the operator picks from (e.g. three free meeting slots). A yes then carries the pick." },
        draft: { type: "string", description: "create, optional: a suggested message the operator may edit before approving. {choice} is replaced by the pick. On yes you get the final text: send exactly that." },
        say: { type: "string", description: "create, optional: one short line the Mac popup speaks (max 160 characters). Default: the title." },
        context: { type: "string", description: "create, optional: a few lines of background shown above the question, e.g. what the other person said (max 600 characters)." },
        id: { type: "string", description: "status: the card id you got from create." },
        channel: { type: "string", description: "Current chat's channel, from your task context, so the result can mention it." },
        chatId: { type: "string", description: "Current chat id, from your task context." },
        callerAgentId: { type: "string", description: "Your agent id. Ignored when the AgentX runtime already identifies you (AGENTX_AGENT_ID)." },
      },
    },
  },
  {
    name: "agentx_request",
    description:
      "Say what you are doing with a request the owner gave you, so it stays on their list of open requests until it is closed. " +
      "Use accept when the work goes on after this turn; wait when the next step is the owner's answer (give the question); " +
      "done when it is finished (give a link to the evidence: PR, issue, message, deploy); decline when you will not do it (give the reason). " +
      "list shows what is still open, oldest first: use it when the owner asks what is still open. " +
      "Without an id, the action applies to the request of the turn you are in; for an older request pass its id (list shows them). You cannot drop a request; only the owner can. " +
      "When the request takes two or more steps done by different agents or at different times (build, deploy, check it is live, tell the client), accept it with steps: a tracked plan. " +
      "The daemon hands each step to its agent in order, nudges a step that goes quiet, sends an owner-approved message itself, and tells the owner at the end or when a step is blocked. " +
      "Report on a step you own with action step (status progress, done with evidence, or blocked with a note). " +
      "Example: {action:'done', evidence:'https://example.com/pull/42'}. " +
      "Plan example: {action:'accept', steps:[{name:'Build the fix', done:'PR merged'}, {name:'Deploy', agent:'devops', kind:'deploy', done:'release live', check:{url:'https://example.com/version', contains:'1.2.3'}}, {name:'Tell the client', kind:'message', message:'The fix is live.', to:{channel:'telegram', chatId:'123'}}]}.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["accept", "wait", "done", "decline", "step", "list"], description: "list (default), accept, wait, done, decline or step." },
        id: { type: "string", description: "The request id, when it is not the request of this turn. Always pass it for step." },
        steps: {
          type: "array",
          description: "accept, optional: two or more steps, in the order they run. Each: name; done (what proves it is finished); agent (owner, default you); kind (task, deploy, verify, message…, default task); for kind message: message (the text) and to {channel, chatId}; optional check {url, contains} the daemon polls; optional stallMinutes.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              done: { type: "string" },
              agent: { type: "string" },
              kind: { type: "string" },
              message: { type: "string" },
              to: { type: "object", properties: { channel: { type: "string" }, chatId: { type: "string" }, accountId: { type: "string" } } },
              check: { type: "object", properties: { url: { type: "string" }, contains: { type: "string" } } },
              stallMinutes: { type: "number" },
            },
            required: ["name"],
          },
        },
        step: { type: "number", description: "step: the step's number in the plan (1 is the first)." },
        status: { type: "string", enum: ["progress", "done", "blocked"], description: "step: progress (still under way), done (give evidence) or blocked (give note)." },
        note: { type: "string", description: "step: what is happening, or why it is blocked." },
        question: { type: "string", description: "wait: what you are asking the owner." },
        evidence: { type: "string", description: "done: a link to the proof (PR, issue, message, deploy)." },
        reason: { type: "string", description: "decline: why you will not do it." },
        channel: { type: "string", description: "Current chat's channel, from your task context." },
        chatId: { type: "string", description: "Current chat id, from your task context." },
        callerAgentId: { type: "string", description: "Your agent id. Ignored when the AgentX runtime already identifies you (AGENTX_AGENT_ID)." },
      },
    },
  },
  {
    name: "agentx_debug",
    description:
      "Toggle debug mode on the daemon. Enable verbose logging for specific categories (webhook, agent, channel, cron, mesh, context, memory, all) or disable it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          description: '"on", "off", or "status"',
          default: "status",
        },
        categories: {
          type: "string",
          description: 'Comma-separated categories to enable (e.g. "webhook,agent"). Only used with action=on.',
        },
      },
    },
  },
  {
    name: "agentx_wiki_query",
    description:
      "Query the agentx institutional wiki: a cross-agent knowledge base organized by article type (person, project, place, concept, event, decision, pattern). Use this BEFORE grep/memory-search when the question is about who / what happened / what we decided / how we do something. The query walks the catalog + wikilink graph and returns a synthesized answer with citations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        question: {
          type: "string",
          description: "The question to answer from the wiki, in natural language.",
        },
        agent: {
          type: "string",
          description: "Which agent's wiki to query (default: first agent with a catalog). Each agent has its own wiki dir under .agentx/wiki/agents/<id>/",
        },
        wiki_dir: {
          type: "string",
          description: "Wiki root dir (default: <cwd>/.agentx/wiki).",
        },
        max_hops: {
          type: "number",
          description: "Wikilink hops from candidates (default 2, max 3).",
          default: 2,
        },
      },
      required: ["question"],
    },
  },
  {
    name: "agentx_wiki_patch",
    description:
      "Edit a single wiki article via an LLM-applied instruction and write the result. Use this for targeted fixes, additions, or clarifications to an existing article when you already know what's wrong. For brand-new articles, use `agentx_wiki_interview` instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Agent ID whose wiki owns the article (required).",
        },
        title_or_path: {
          type: "string",
          description: "Article title (case-insensitive) or relative path like 'people/alex.md'.",
        },
        instruction: {
          type: "string",
          description: "Plain-English edit instruction (e.g. 'Add a section on the KSA Supabase rollout'). The LLM makes the minimum edit that satisfies it.",
        },
        model: {
          type: "string",
          description: "Claude model for the patch (default: sonnet).",
          default: "sonnet",
        },
        dry_run: {
          type: "boolean",
          description: "Preview the patched body without writing.",
          default: false,
        },
      },
      required: ["agent", "title_or_path", "instruction"],
    },
  },
  {
    name: "agentx_wiki_interview",
    description:
      "Run a scripted wiki interview — synthesize ONE typed article from a list of Q&A answers, and save it. Non-interactive: caller supplies the answers upfront. Use for capturing tacit knowledge (person/project/decision/pattern/...) that never hit a channel. For editing an existing article, use `agentx_wiki_patch`.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agent: {
          type: "string",
          description: "Agent ID that will own the new article (required).",
        },
        topic: {
          type: "string",
          description: "What the article is about — e.g. 'Globex deployment procedure', 'Jane Doe', 'DemoSite KSA migration'.",
        },
        type: {
          type: "string",
          description: "Article type: person | project | place | concept | event | decision | pattern",
        },
        answers: {
          type: "array",
          description: "Answers to the type-specific question bank (one per question, in order). Empty string = skip that question. Final entry is typically 'save'.",
          items: { type: "string" },
        },
        model: {
          type: "string",
          description: "Synthesis model (default: sonnet).",
          default: "sonnet",
        },
        commit: {
          type: "boolean",
          description: "Write the article (true) or just preview (false).",
          default: true,
        },
      },
      required: ["agent", "topic", "type", "answers"],
    },
  },
  {
    name: "agentx_graph_review",
    description:
      "Triage pending intent-graph classifications via the configured review agent. The review agent sees each pending classification, may call `wiki query` for institutional context, and decides approve/reject/skip. Structural changes (new org, new unit) gate here; leaf additions auto-approve without this step.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max: {
          type: "number",
          description: "Cap reviews this run (default 20).",
          default: 20,
        },
        dry_run: {
          type: "boolean",
          description: "Show decisions but don't apply approvals/rejections.",
          default: false,
        },
        agent: {
          type: "string",
          description: "Override the review agent (defaults to graph.reviewAgent or graph.draftAgent).",
        },
      },
    },
  },
]

// Tool handlers
async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text: string }[] }> {
  const cwd = (args.cwd as string) || process.cwd()

  switch (name) {
    case "agentx_generate": {
      const task = args.task as string
      const outputType = (args.type as string) || "auto"
      const outputDir = args.output_dir as string | undefined

      const result = await generate({
        task,
        outputType: outputType as OutputType,
        outputDir,
        cwd,
        overwrite: true,
        dryRun: false,
        context7: true,
        interactive: false,
        maxSteps: 5,
      })

      const summary: string[] = []
      if (result.content) summary.push(result.content)
      if (result.files.written.length) {
        summary.push(
          `\nCreated ${result.files.written.length} file(s):\n${result.files.written.map((f) => `  - ${f}`).join("\n")}`
        )
      }
      if (result.files.skipped.length) {
        summary.push(
          `\nSkipped ${result.files.skipped.length} existing file(s):\n${result.files.skipped.map((f) => `  - ${f}`).join("\n")}`
        )
      }
      if (result.followUp) {
        summary.push(`\nNeeds clarification: ${result.followUp}`)
      }

      return {
        content: [{ type: "text", text: summary.join("\n") || "Generation complete." }],
      }
    }

    case "agentx_inspect": {
      const context = await createAgentContext(cwd, "inspect", {
        context7: { enabled: false },
      })

      const info: Record<string, unknown> = {
        languages: context.techStack.languages,
        frameworks: context.techStack.frameworks,
        packageManager: context.techStack.packageManager,
        databases: context.techStack.databases,
        styling: context.techStack.styling,
        testing: context.techStack.testing,
        deployment: context.techStack.deployment,
        monorepo: context.techStack.monorepo,
        srcDir: context.techStack.srcDir,
        dependencyCount: Object.keys(context.techStack.dependencies).length,
        devDependencyCount: Object.keys(context.techStack.devDependencies).length,
        schemas: {
          database: context.schemas.database
            ? {
                type: context.schemas.database.type,
                tables: context.schemas.database.tables,
              }
            : null,
          api: context.schemas.api ? { type: context.schemas.api.type } : null,
          env: context.schemas.env
            ? { variableCount: context.schemas.env.variables.length }
            : null,
          models: context.schemas.models?.map((m) => m.path) || [],
        },
        skills: context.skills.map((s) => ({
          name: s.frontmatter.name,
          description: s.frontmatter.description,
          source: s.source,
        })),
      }

      return {
        content: [
          {
            type: "text",
            text: `Project analysis:\n\n${formatTechStack(context.techStack)}\n\n${JSON.stringify(info, null, 2)}`,
          },
        ],
      }
    }

    case "agentx_skill_match": {
      const task = args.task as string
      const skills = await loadLocalSkills(cwd)
      const matches = matchSkillsToTask(skills, task)

      if (!matches.length) {
        return {
          content: [
            {
              type: "text",
              text: "No matching skills found. Install skills with: agentx skill install <owner/repo>",
            },
          ],
        }
      }

      const text = matches
        .map(
          (m) =>
            `- **${m.skill.frontmatter.name}** (relevance: ${(m.relevance * 100).toFixed(0)}%)\n  ${m.skill.frontmatter.description}\n  Match: ${m.matchReason}`
        )
        .join("\n\n")

      return {
        content: [{ type: "text", text: `Matching skills:\n\n${text}` }],
      }
    }

    case "agentx_detect_output_type": {
      const task = args.task as string
      const type = resolveOutputType(undefined, task)
      return {
        content: [
          {
            type: "text",
            text: `Detected output type: ${type}`,
          },
        ],
      }
    }

    // --- Daemon tools ---

    case "agentx_channel_reply": {
      const channel = args.channel as string | undefined
      const chatId = args.chatId as string | undefined
      const text = args.text as string | undefined
      if (!channel || !chatId || !text) {
        return { content: [{ type: "text", text: "Error: channel, chatId, and text are required." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/api/actions/builtin/channel.reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel, chatId, text,
          agentId: args.agentId,
          accountId: args.accountId,
          replyTo: args.replyTo,
          idempotencyKey: args.idempotencyKey,
        }),
      })
      const data = await res.json() as any
      if (!res.ok || data.error) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      const messageId = data?.output?.messageId ?? data?.messageId ?? null
      return { content: [{ type: "text", text: messageId ? `Reply posted. messageId=${messageId}` : "Reply suppressed by dedupe (same body within 60s window)." }] }
    }

    case "agentx_channel_label": {
      const channel = (args.channel as string | undefined) ?? "gitlab"
      const project = args.project as string | undefined
      const kind = args.kind as string | undefined
      const iid = args.iid as string | undefined
      if (!project || !kind || !iid) {
        return { content: [{ type: "text", text: "Error: project, kind, and iid are required." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/api/actions/builtin/channel.label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel, project, kind, iid,
          add: Array.isArray(args.add) ? args.add : [],
          remove: Array.isArray(args.remove) ? args.remove : [],
          agentId: args.agentId,
        }),
      })
      const data = await res.json() as any
      if (!res.ok || data.error) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      const labels = data?.output?.labels ?? []
      return { content: [{ type: "text", text: `Labels updated. Current: ${Array.isArray(labels) ? labels.join(", ") : "(unknown)"}` }] }
    }

    case "agentx_send": {
      let channel = args.channel as string | undefined
      let chatId = args.chatId as string | undefined
      let text = args.text as string | undefined

      // Elicit missing required params
      if (!channel || !chatId || !text) {
        const channelsRes = await daemonFetch(`${daemonUrl()}/channels`).catch(() => null)
        const channels = channelsRes ? await channelsRes.json() as string[] : ["telegram", "whatsapp", "gitlab", "discord"]

        const response = await elicit(
          "Please provide the message details:",
          {
            type: "object",
            properties: {
              channel: { type: "string", title: "Channel", description: "Target channel", enum: channels, default: channel || channels[0] },
              chatId: { type: "string", title: "Chat ID", description: "Telegram: numeric ID. GitLab: group/project:issue:123", default: chatId || "" },
              text: { type: "string", title: "Message", description: "Message text to send", default: text || "" },
            },
            required: ["channel", "chatId", "text"],
          },
        )
        if (!response) return { content: [{ type: "text", text: "Send cancelled." }] }
        channel = response.channel as string
        chatId = response.chatId as string
        text = response.text as string
      }

      const res = await daemonFetch(`${daemonUrl()}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, chatId, text, agentId: args.agentId }),
      })
      const data = await res.json() as any
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      return { content: [{ type: "text", text: `Message sent. ID: ${data.messageId || "ok"}` }] }
    }

    case "agentx_send_agent": {
      const agentId = args.agentId as string | undefined
      const text = args.text as string | undefined
      const senderAgentId = args.senderAgentId as string | undefined
      if (!agentId || !text) {
        return { content: [{ type: "text", text: "Error: agentId and text are required." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/send/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, text, senderAgentId: senderAgentId || process.env.AGENTX_AGENT_ID, ...callerFields() }),
      })
      const data = await res.json() as any
      if (res.status === 202 && data?.accepted) {
        return { content: [{ type: "text", text: data.note || `Delegated to ${agentId} (task ${data.taskId}).` }] }
      }
      if (!res.ok) {
        const known = Array.isArray(data?.known) ? ` Known agents: ${data.known.join(", ")}.` : ""
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}.${known}` }] }
      }
      const peerInfo = data.peer ? ` (via mesh peer ${data.peer})` : ""
      return { content: [{ type: "text", text: `Message sent to agent ${agentId}${peerInfo}. ID: ${data.messageId || "ok"}` }] }
    }

    case "agentx_recent": {
      const channel = args.channel as string | undefined
      const chatId = args.chatId as string | undefined
      const sinceISO = args.sinceISO as string | undefined
      const limit = args.limit as number | undefined
      if (!chatId) {
        const agent = process.env.AGENTX_AGENT_ID || (args.agentId as string | undefined)
        if (!agent) return { content: [{ type: "text", text: "Error: chatId is required, or agentId to read across your own chats." }] }
        return recentAcrossChats(agent, channel, limit)
      }
      if (!channel) {
        return { content: [{ type: "text", text: "Error: channel is required with chatId." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/chat/recent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, chatId, sinceISO, limit }),
      })
      const data = await res.json() as any
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      const messages = (data.messages || []) as Array<{ ts: string; role: string; senderName: string; content: string; agentId: string }>
      if (messages.length === 0) {
        return { content: [{ type: "text", text: `No messages in ${channel}/${chatId} within the requested window.` }] }
      }
      // Render as a readable transcript with agentId attribution so the
      // caller can distinguish who said what.
      const lines = messages.map((m) => {
        const time = m.ts.slice(11, 16) // HH:MM
        const day = m.ts.slice(0, 10)
        const who = m.role === "agent" ? `${m.agentId}` : (m.senderName || "user")
        return `[${day} ${time}] ${who}: ${m.content}`
      })
      return { content: [{ type: "text", text: lines.join("\n") }] }
    }

    case "agentx_send_contact": {
      const contactName = args.contactName as string | undefined
      const text = args.text as string | undefined
      const channel = args.channel as string | undefined
      const confirmed = args.confirmed === true
      const agentId = args.agentId as string | undefined
      if (!contactName || !text) {
        return { content: [{ type: "text", text: "Error: contactName and text are required." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/send/contact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactName, text, channel, confirmed, agentId }),
      })
      const data = await res.json() as any
      if (res.status === 409) {
        // Surface the resolution result so the caller can ask the user to disambiguate.
        return { content: [{ type: "text", text: `Refused: ${JSON.stringify(data, null, 2)}` }] }
      }
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      return { content: [{ type: "text", text: `Message sent to contact ${data.contactId} via ${data.channel}. ID: ${data.messageId || "ok"}` }] }
    }

    case "agentx_task": {
      let agent = args.agent as string | undefined
      let message = args.message as string | undefined
      const senderAgentId = (args.senderAgentId as string | undefined) || process.env.AGENTX_AGENT_ID
      const explicitFresh = typeof args.freshSession === "boolean" ? args.freshSession as boolean : undefined
      const freshSession = explicitFresh !== undefined ? explicitFresh : (senderAgentId ? true : undefined)
      const explicitChatId = args.chatId as string | undefined

      // Elicit missing params
      if (!agent || !message) {
        const agentsRes = await daemonFetch(`${daemonUrl()}/agents`).catch(() => null)
        const agentList = agentsRes ? (await agentsRes.json() as any[]).map((a: any) => a.id) : []

        const response = await elicit(
          "Which agent should handle this task?",
          {
            type: "object",
            properties: {
              agent: { type: "string", title: "Agent", description: "Agent ID", ...(agentList.length ? { enum: agentList } : {}), default: agent || "" },
              message: { type: "string", title: "Task", description: "Task message for the agent", default: message || "" },
            },
            required: ["agent", "message"],
          },
        )
        if (!response) return { content: [{ type: "text", text: "Task cancelled." }] }
        agent = response.agent as string
        message = response.message as string
      }

      const chatId = explicitChatId || (senderAgentId
        ? `mcp:${senderAgentId}:${agent}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        : undefined)
      const context = chatId ? {
        channel: "mcp",
        sender: senderAgentId ? `agent:${senderAgentId}` : "mcp",
        chatId,
      } : undefined

      const res = await daemonFetch(`${daemonUrl()}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, message, senderAgentId, freshSession, context, ...callerFields() }),
      })
      const data = await res.json() as any
      // #277 — the daemon took it in the background (a person is waiting
      // on this conversation); the answer comes back as a new turn.
      if (res.status === 202 && data?.accepted) {
        return { content: [{ type: "text", text: data.note || `Delegated to ${agent} (task ${data.taskId}).` }] }
      }
      if (data.error) {
        return { content: [{ type: "text", text: `Agent error: ${data.error}` }] }
      }
      return { content: [{ type: "text", text: data.content || "Task completed." }] }
    }

    case "agentx_agents": {
      const res = await daemonFetch(`${daemonUrl()}/agents`)
      const agents = await res.json() as any[]
      const lines = agents.map((a: any) =>
        `${a.id} (${a.name}) — ${a.tier}, active: ${a.active}/${a.total}, errors: ${a.errors}`
      )
      const text = lines.join("\n") || "No agents."
      if (args.landscape !== true) return { content: [{ type: "text", text }] }
      const agent = process.env.AGENTX_AGENT_ID || (args.agentId as string | undefined)
      if (!agent) return { content: [{ type: "text", text: `${text}\n\nNo landscape: pass agentId to say whose to return.` }] }
      return { content: [{ type: "text", text: `${text}\n\n${await fetchLandscape(agent)}` }] }
    }

    case "agentx_voice_queue": {
      const res = await daemonFetch(`${daemonUrl()}/voice/queue`)
      if (!res.ok) return { content: [{ type: "text", text: `Could not read the speaking queue: HTTP ${res.status}` }] }
      return { content: [{ type: "text", text: describeQueue(await res.json() as QueueView) }] }
    }

    case "agentx_call_owner": {
      // The daemon checks this against a running turn of the agent.
      const agentId = process.env.AGENTX_AGENT_ID
      if (!agentId) return { content: [{ type: "text", text: "Call not placed: only an agent's own run can call (AGENTX_AGENT_ID is not set)." }] }
      const res = await daemonFetch(`${daemonUrl()}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...callerHeaders() },
        body: JSON.stringify({ agentId, reason: args.reason, urgency: args.urgency }),
      })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return { content: [{ type: "text", text: `Call not placed: ${data?.error || `HTTP ${res.status}`}` }] }
      const how = data.rang === "widget" ? "It is ringing on the owner's desktop widget. When they answer you will be asked to open the conversation."
        : data.rang === "notify" ? "The desktop widget is not running, so the owner got a notification instead."
        : `It did not ring (${data.call?.note ?? "held"}); the owner sees it as a missed call.`
      return { content: [{ type: "text", text: `Call ${data.call?.id} placed. ${how}` }] }
    }

    case "agentx_camera_ask": {
      const agentId = process.env.AGENTX_AGENT_ID
      if (!agentId) return { content: [{ type: "text", text: "Not asked: only an agent's own run can ask to see (AGENTX_AGENT_ID is not set)." }] }
      const res = await daemonFetch(`${daemonUrl()}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...callerHeaders() },
        body: JSON.stringify({ agentId, reason: args.reason, urgency: args.urgency, kind: "camera" }),
      })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return { content: [{ type: "text", text: `Not asked: ${data?.error || `HTTP ${res.status}`}` }] }
      const how = data.rang
        ? "The owner's phone was told. If they tap Show, the camera opens and you can call agentx_camera_look; you will not be told when, so look when they say they are ready, or try in a moment."
        : `It did not reach them now (${data.call?.note ?? "held"}); they see it as a missed ask.`
      return { content: [{ type: "text", text: `Ask ${data.call?.id} placed. ${how}` }] }
    }

    case "agentx_camera_look": {
      const agentId = process.env.AGENTX_AGENT_ID
      if (!agentId) return { content: [{ type: "text", text: "No picture: only an agent's own run can look (AGENTX_AGENT_ID is not set)." }] }
      const res = await daemonFetch(`${daemonUrl()}/webrtc/camera/look`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...callerHeaders() },
        body: JSON.stringify({ agentId }),
      })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) return { content: [{ type: "text", text: `No picture: ${data?.error || `HTTP ${res.status}`}` }] }
      const f = data.frame
      return { content: [{ type: "text", text: `The newest frame (${f.width}x${f.height}, taken ${new Date(f.takenAt).toLocaleTimeString()}) is at:\n${f.path}\nOpen it with your Read tool.` }] }
    }

    case "agentx_health": {
      const res = await daemonFetch(`${daemonUrl()}/health`)
      const data = await res.json() as any
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
    }

    // Attach mode. The session id comes from the environment Claude Code
    // exports, not from the model — an attached session must never be able to
    // drain or answer on behalf of a DIFFERENT session by passing an id.
    case "agentx_attach_next": {
      const sessionId = process.env.CLAUDE_CODE_SESSION_ID
      if (!sessionId) {
        return { content: [{ type: "text", text: "Not running inside a Claude Code session — attach mode is unavailable here." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/attach/next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json() as any
      if (!data?.item) {
        return { content: [{ type: "text", text: "Inbox empty — nothing queued for this session." }] }
      }
      const i = data.item
      const text = [
        `Message for "${i.agentId}" via ${i.channel} from ${i.sender}:`,
        "",
        i.text,
        "",
        `Answer as "${i.agentId}". Your reply is sent back to ${i.channel} verbatim.`,
        data.pending > 0 ? `(${data.pending} more waiting after this one.)` : "",
      ].filter(Boolean).join("\n")
      return { content: [{ type: "text", text }] }
    }

    case "agentx_attach_answer": {
      const sessionId = process.env.CLAUDE_CODE_SESSION_ID
      if (!sessionId) {
        return { content: [{ type: "text", text: "Not running inside a Claude Code session — attach mode is unavailable here." }] }
      }
      const res = await daemonFetch(`${daemonUrl()}/attach/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, text: String(args.text ?? "") }),
      })
      const data = await res.json() as any
      if (!res.ok) {
        return { content: [{ type: "text", text: `Could not answer: ${data?.error ?? res.status}` }] }
      }
      const more = data.pending > 0 ? ` ${data.pending} still queued.` : ""
      return { content: [{ type: "text", text: `Sent to ${data.item?.channel}.${more}` }] }
    }

    case "agentx_events": {
      const agentId = process.env.AGENTX_AGENT_ID || (args.agentId as string | undefined)
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: agentId is required (no AGENTX_AGENT_ID in this session)." }] }
      }
      const qs = new URLSearchParams()
      if (typeof args.since === "string" && args.since) qs.set("since", args.since)
      if (typeof args.limit === "number") qs.set("limit", String(args.limit))
      const res = await daemonFetch(`${daemonUrl()}/agents/${encodeURIComponent(agentId)}/events?${qs}`, { signal: AbortSignal.timeout(10_000) })
      const data = await res.json().catch(() => ({})) as any
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      const { formatEventLine } = await import("@/events/subscriptions")
      return { content: [{ type: "text", text: renderEventsAnswer(agentId, data, formatEventLine) }] }
    }

    case "agentx_crons": {
      const res = await daemonFetch(`${daemonUrl()}/crons/health`)
      const data = await res.json() as any
      const summary = `Healthy: ${data.healthy}, Failing: ${data.failing}, Disabled: ${data.disabled}, Missed: ${data.missed}`
      const jobs = (data.jobs || []).map((j: any) =>
        `  ${j.id}: ${j.status}${j.consecutiveErrors ? ` (${j.consecutiveErrors} errors)` : ""}${j.lastError ? ` — ${j.lastError.slice(0, 100)}` : ""}`
      ).join("\n")
      return { content: [{ type: "text", text: `${summary}\n\n${jobs}` }] }
    }

    case "agentx_schedule": {
      const { runScheduleTool, resolveScheduleCaller } = await import("@/crons/schedule-tool")
      const text = await runScheduleTool(args, resolveScheduleCaller(args), {
        notifyOperator: async (dest, message) => {
          const res = await daemonFetch(`${daemonUrl()}/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ channel: dest.channel, chatId: dest.chatId, accountId: dest.accountId, text: message }),
            signal: AbortSignal.timeout(10_000),
          })
          if (!res.ok) {
            const data = await res.json().catch(() => ({})) as any
            throw new Error(data?.error || `HTTP ${res.status}`)
          }
        },
      })
      return { content: [{ type: "text", text }] }
    }

    case "agentx_approval": {
      const { runApprovalTool } = await import("@/approvals/tool")
      const text = await runApprovalTool(args, { daemonUrl: daemonUrl(), fetch: daemonFetch })
      return { content: [{ type: "text", text }] }
    }

    case "agentx_request": {
      const { runRequestTool } = await import("@/requests/tool")
      const text = await runRequestTool(args, { daemonUrl: daemonUrl(), fetch: daemonFetch })
      return { content: [{ type: "text", text }] }
    }

    case "agentx_wiki_query": {
      const question = String(args.question || "").trim()
      if (!question) {
        return { content: [{ type: "text", text: "Error: `question` is required." }] }
      }
      const { WikiHub } = await import("@/wiki")
      const { agenticQuery } = await import("@/wiki/query")
      const { resolve } = await import("path")
      const wikiDir = (args.wiki_dir as string) || resolve(process.cwd(), ".agentx/wiki")
      const hub = new WikiHub(wikiDir, undefined, "graph")
      let agentId = (args.agent as string) || ""
      if (!agentId) {
        // Fall back to first agent with a catalog
        const { existsSync } = await import("fs")
        for (const id of hub.listAgents()) {
          const catPath = resolve(hub.getAgentWiki(id).baseDir, "_index.md")
          if (existsSync(catPath)) { agentId = id; break }
        }
      }
      if (!agentId) {
        return { content: [{ type: "text", text: "Error: no agent has a wiki catalog yet. Run `agentx wiki absorb` first." }] }
      }
      const store = hub.getAgentWiki(agentId)
      const maxHops = typeof args.max_hops === "number" ? Math.min(3, Math.max(0, args.max_hops)) : 2
      // The request this tool serves was classified into the intent graph
      // on its way in. Articles on the same branch rank higher; without
      // this the graph weight of the retrieval score multiplied zero. The
      // daemon answers for the turn that is running now, or with nothing
      // while that turn's classification is still in flight: reading the
      // classification log here would hand back the previous request's
      // path, since classification runs alongside the turn.
      const branch = await runningIntentPath()
      const result = await agenticQuery(question, store, agentId, {
        maxHops,
        messagePath: branch?.path,
        ...(branch?.graphWeight !== undefined ? { graphWeight: branch.graphWeight } : {}),
      })
      if (result.status !== "ok") {
        return { content: [{ type: "text", text: `Query returned status "${result.status}"${result.error ? `: ${result.error}` : ""}` }] }
      }
      const cites = result.citations.map(c => `  - ${c.title} [${c.type || "?"}] (${c.path})`).join("\n")
      const walkCount = result.walked.length
      const body = `${result.answer}\n\nCitations (${walkCount} article${walkCount === 1 ? "" : "s"} walked):\n${cites}`
      return { content: [{ type: "text", text: body }] }
    }

    case "agentx_wiki_patch": {
      const agent = String(args.agent || "").trim()
      const titleOrPath = String(args.title_or_path || "").trim()
      const instruction = String(args.instruction || "").trim()
      if (!agent || !titleOrPath || !instruction) {
        return { content: [{ type: "text", text: "Error: `agent`, `title_or_path`, and `instruction` are required." }] }
      }
      const model = String(args.model || "sonnet")
      const dry = args.dry_run === true
      const { execFileSync } = await import("child_process")
      const flags = ["wiki", "patch", agent, titleOrPath, instruction, "--patch-model", model, ...(dry ? ["--no-commit"] : ["--yes"])]
      try {
        const out = execFileSync(process.execPath, [process.argv[1], ...flags], {
          cwd,
          encoding: "utf-8",
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        return { content: [{ type: "text", text: stripAnsi(out).trim() || "(no output)" }] }
      } catch (e: any) {
        const combined = [e.stdout, e.stderr, e.message].filter(Boolean).map((s: any) => stripAnsi(String(s))).join("\n").trim()
        return { content: [{ type: "text", text: `patch failed:\n${combined.slice(0, 2000)}` }] }
      }
    }

    case "agentx_wiki_interview": {
      const agent = String(args.agent || "").trim()
      const topic = String(args.topic || "").trim()
      const type = String(args.type || "").trim().toLowerCase()
      const answers = Array.isArray(args.answers) ? (args.answers as any[]).map(a => String(a ?? "")) : null
      if (!agent || !topic || !type || !answers || answers.length === 0) {
        return { content: [{ type: "text", text: "Error: `agent`, `topic`, `type`, and non-empty `answers[]` are required." }] }
      }
      const model = String(args.model || "sonnet")
      const commit = args.commit !== false
      // Last line in --answers is typically the save/edit/scrap verdict — default save.
      const terminal = answers[answers.length - 1]?.toLowerCase()
      const finalAnswers = ["save", "edit", "scrap"].includes(terminal) ? answers : [...answers, "save"]
      const { execFileSync } = await import("child_process")
      const { writeFileSync, mkdtempSync } = await import("fs")
      const { tmpdir } = await import("os")
      const { join } = await import("path")
      const tmp = mkdtempSync(join(tmpdir(), "agentx-mcp-interview-"))
      const answersPath = join(tmp, "answers.txt")
      writeFileSync(answersPath, finalAnswers.join("\n"))
      const flags = [
        "wiki", "interview",
        "--agent", agent,
        "--topic", topic,
        "--type", type,
        "--model", model,
        "--answers", answersPath,
        ...(commit ? [] : ["--no-commit"]),
      ]
      try {
        const out = execFileSync(process.execPath, [process.argv[1], ...flags], {
          cwd,
          encoding: "utf-8",
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        return { content: [{ type: "text", text: stripAnsi(out).trim() || "(no output)" }] }
      } catch (e: any) {
        const combined = [e.stdout, e.stderr, e.message].filter(Boolean).map((s: any) => stripAnsi(String(s))).join("\n").trim()
        return { content: [{ type: "text", text: `interview failed:\n${combined.slice(0, 2000)}` }] }
      }
    }

    case "agentx_graph_review": {
      const max = typeof args.max === "number" ? Math.max(1, args.max as number) : 20
      const dry = args.dry_run === true
      const agent = args.agent ? String(args.agent) : ""
      const { execFileSync } = await import("child_process")
      const flags = ["graph", "review", "--max", String(max), ...(dry ? ["--dry-run"] : []), ...(agent ? ["--agent", agent] : [])]
      try {
        const out = execFileSync(process.execPath, [process.argv[1], ...flags], {
          cwd,
          encoding: "utf-8",
          timeout: 600_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        return { content: [{ type: "text", text: stripAnsi(out).trim() || "(no output)" }] }
      } catch (e: any) {
        const combined = [e.stdout, e.stderr, e.message].filter(Boolean).map((s: any) => stripAnsi(String(s))).join("\n").trim()
        return { content: [{ type: "text", text: `graph review failed:\n${combined.slice(0, 2000)}` }] }
      }
    }

    case "agentx_debug": {
      const action = (args.action as string) || "status"
      if (action === "on") {
        const cats = (args.categories as string) || "all"
        await daemonFetch(`${daemonUrl()}/debug/on?categories=${cats}`, { method: "POST" })
        return { content: [{ type: "text", text: `Debug enabled: ${cats}` }] }
      } else if (action === "off") {
        await daemonFetch(`${daemonUrl()}/debug/off`, { method: "POST" })
        return { content: [{ type: "text", text: "Debug disabled." }] }
      } else {
        const res = await daemonFetch(`${daemonUrl()}/debug`)
        const data = await res.json() as any
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// --- Stdio transport ---

/** Parse one frame + dispatch. Shared between the header-framed and
 *  newline-framed paths so the routing is in one place. */
function dispatch(raw: string, log: (...args: unknown[]) => void): void {
  let msg: any
  try {
    msg = JSON.parse(raw)
  } catch (e) {
    log("Failed to parse message:", e)
    return
  }
  if (msg.id && typeof msg.id === "string" && msg.id.startsWith("elicit-") && msg.result) {
    const resolver = elicitationResolvers.get(msg.id)
    if (resolver) {
      elicitationResolvers.delete(msg.id)
      resolver(msg.result)
    }
    return
  }
  handleMessage(msg, log).catch((e) => log("Error:", e))
}

/** The tool set this server runs with, from `agentx serve --tools`. */
let activeToolSet: McpToolSet = "full"

export async function startMcpServer(opts: { tools?: McpToolSet } = {}): Promise<void> {
  // Use stderr for logging (stdout is reserved for JSON-RPC)
  const log = (...args: unknown[]) => console.error("[agentx-mcp]", ...args)
  activeToolSet = opts.tools ?? "full"

  log(`Starting MCP server (stdio transport, ${activeToolSet} tools)...`)

  let buffer = ""

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk

    // MCP stdio transport is newline-delimited JSON. Some legacy clients
    // (LSP-style) use `Content-Length: N\r\n\r\n<body>` framing, so we
    // accept both: prefer header framing when the start of the buffer
    // looks like a header, otherwise fall back to NDJSON.
    while (buffer.length > 0) {
      const looksLikeHeader = buffer.startsWith("Content-Length:")
      if (looksLikeHeader) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd === -1) break
        const header = buffer.slice(0, headerEnd)
        const m = header.match(/Content-Length:\s*(\d+)/)
        if (!m) {
          // Malformed header; drop up to the separator and continue.
          buffer = buffer.slice(headerEnd + 4)
          continue
        }
        const contentLength = parseInt(m[1], 10)
        const bodyStart = headerEnd + 4
        const bodyEnd = bodyStart + contentLength
        if (buffer.length < bodyEnd) break
        const body = buffer.slice(bodyStart, bodyEnd)
        buffer = buffer.slice(bodyEnd)
        dispatch(body, log)
      } else {
        const newlineIdx = buffer.indexOf("\n")
        if (newlineIdx === -1) break
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line) dispatch(line, log)
      }
    }
  })

  process.stdin.on("end", () => {
    log("stdin closed, shutting down.")
    process.exit(0)
  })
}

/** The tools `tools/list` returns. A lean session names a short list in
 *  AGENTX_MCP_TOOLS (#699; see src/agents/session-profile.ts) so its first
 *  turn carries fewer descriptions. Unset, or naming no known tool: every
 *  tool. Calls are not filtered; the list only decides what is described. */
export function listedTools(env: NodeJS.ProcessEnv = process.env, toolSet: McpToolSet = activeToolSet): typeof TOOLS {
  const offered = toolSetTools(toolSet)
  const wanted = new Set((env.AGENTX_MCP_TOOLS ?? "").split(",").map((t) => t.trim()).filter(Boolean))
  if (!wanted.size) return offered
  const kept = offered.filter((t) => wanted.has(t.name))
  return kept.length ? kept : offered
}

/** Every tool in a set (#794). Unlike AGENTX_MCP_TOOLS, a set is a
 *  boundary: a call to a tool outside it is refused, not only unlisted. */
export function toolSetTools(toolSet: McpToolSet): typeof TOOLS {
  if (toolSet === "full") return TOOLS
  const allowed = new Set(READ_TOOL_NAMES)
  return TOOLS.filter((t) => allowed.has(t.name))
}

export function toolInSet(name: string, toolSet: McpToolSet = activeToolSet): boolean {
  return toolSet === "full" || READ_TOOL_NAMES.includes(name)
}

function send(message: JsonRpcResponse | JsonRpcNotification): void {
  // MCP stdio: newline-delimited JSON. Modern MCP clients (Claude Code,
  // Cursor, Windsurf) all expect this. Content-Length framing is LSP-era
  // and no observed client requires it; if one does, they can parse the
  // trailing newline harmlessly.
  process.stdout.write(JSON.stringify(message) + "\n")
}

async function handleMessage(
  msg: JsonRpcRequest,
  log: (...args: unknown[]) => void
): Promise<void> {
  const { method, id, params } = msg

  log(`Received: ${method}`)

  switch (method) {
    case "initialize": {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiateProtocolVersion((params as any)?.protocolVersion),
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      })
      break
    }

    case "notifications/initialized": {
      log("Client initialized.")
      break
    }

    case "tools/list": {
      send({
        jsonrpc: "2.0",
        id,
        result: { tools: listedTools() },
      })
      break
    }

    case "tools/call": {
      const toolName = (params as any)?.name as string
      const toolArgs = ((params as any)?.arguments || {}) as Record<string, unknown>

      try {
        if (!toolInSet(toolName)) {
          throw new Error(`${toolName} is not in the "${activeToolSet}" tool set. Restart the server with --tools full to use it.`)
        }
        const result = await handleToolCall(toolName, toolArgs)
        send({
          jsonrpc: "2.0",
          id,
          result,
        })
      } catch (error: any) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
          },
        })
      }
      break
    }

    case "ping": {
      send({ jsonrpc: "2.0", id, result: {} })
      break
    }

    default: {
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        })
      }
    }
  }
}
