import { createAgentContext } from "@/agent"
import { detectTechStack, formatTechStack } from "@/agent/context/tech-stack"
import { detectSchemas, formatSchemas } from "@/agent/context/schema"
import { loadLocalSkills, matchSkillsToTask } from "@/agent/skills/loader"
import { resolveOutputType } from "@/agent/outputs/types"
import { generate } from "@/agent"
import type { OutputType } from "@/agent/providers/types"

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

const PROTOCOL_VERSION = "2024-11-05"

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

// Default daemon URL (local)
const DAEMON_URL = process.env.AGENTX_DAEMON_URL || "http://localhost:19900"

// Strip ANSI escape codes from CLI output (we re-invoke the CLI for tools
// that shell out — chalk colors its output, MCP clients want plain text).
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g
function stripAnsi(s: string): string { return s.replace(ANSI_RE, "") }

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
      "Send a message to ANOTHER AGENT by exact agentId — uses the AgentX A2A mesh (or local registry when the agent lives on this daemon). This is the deterministic path for agent-to-agent communication; it never falls through to a contact lookup, so an unknown agentId returns 404 with the list of known agents instead of silently sending to a similarly-named human. Use this when the target is a registered agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: {
          type: "string",
          description: "Exact agentId of the target agent (e.g. 'clawd', 'atlas'). Must match an agent in this daemon's registry or in a healthy mesh peer's directory.",
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
      "Read the most recent messages from a chat across ALL agents that have sessions for it. Returns inbound + each agent's replies in chronological order, so you can see what's actually been said in a Telegram chat / GitLab thread / WhatsApp DM regardless of which agent recorded it. Use this BEFORE speculating about what was sent — the cx/devops/marketing thread on 2026-04-29 about a Nadia/CX bot mixup would have been resolved in one call instead of three agents speculating. Bounded by sinceISO (default: last 24h) and limit (default: 30, max: 200).",
    inputSchema: {
      type: "object" as const,
      properties: {
        channel: {
          type: "string",
          description: "Channel name. Examples: telegram, whatsapp, gitlab, github, discord, cron, api, a2a.",
        },
        chatId: {
          type: "string",
          description: "Channel-native chat id. Telegram: numeric (e.g. \"1816212449\" for a DM, \"-1001234567890\" for a group). GitLab: \"group/project:issue:123\". WhatsApp: \"+phone@s.whatsapp.net\".",
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
      required: ["channel", "chatId"],
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
      "Send a task to a specific agent on the daemon. The agent processes it and returns a response. Use to delegate work to specialized agents.",
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
      "List all agents registered on the daemon with their status (active tasks, total tasks, errors, tier).",
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
    name: "agentx_crons",
    description:
      "List cron jobs and their health. Shows healthy, failing, disabled counts and per-job status with consecutive error counts.",
    inputSchema: {
      type: "object" as const,
      properties: {},
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
          description: "Article title (case-insensitive) or relative path like 'people/anis.md'.",
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
          description: "What the article is about — e.g. 'MTGL deployment procedure', 'Yousef Al-Fahad', 'Hackathonat KSA migration'.",
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
      const res = await fetch(`${DAEMON_URL}/api/actions/builtin/channel.reply`, {
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
      const res = await fetch(`${DAEMON_URL}/api/actions/builtin/channel.label`, {
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
        const channelsRes = await fetch(`${DAEMON_URL}/channels`).catch(() => null)
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

      const res = await fetch(`${DAEMON_URL}/send`, {
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
      const res = await fetch(`${DAEMON_URL}/send/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, text, senderAgentId }),
      })
      const data = await res.json() as any
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
      if (!channel || !chatId) {
        return { content: [{ type: "text", text: "Error: channel and chatId are required." }] }
      }
      const res = await fetch(`${DAEMON_URL}/chat/recent`, {
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
      const res = await fetch(`${DAEMON_URL}/send/contact`, {
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
        const agentsRes = await fetch(`${DAEMON_URL}/agents`).catch(() => null)
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

      const res = await fetch(`${DAEMON_URL}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, message, senderAgentId, freshSession, context }),
      })
      const data = await res.json() as any
      if (data.error) {
        return { content: [{ type: "text", text: `Agent error: ${data.error}` }] }
      }
      return { content: [{ type: "text", text: data.content || "Task completed." }] }
    }

    case "agentx_agents": {
      const res = await fetch(`${DAEMON_URL}/agents`)
      const agents = await res.json() as any[]
      const lines = agents.map((a: any) =>
        `${a.id} (${a.name}) — ${a.tier}, active: ${a.active}/${a.total}, errors: ${a.errors}`
      )
      return { content: [{ type: "text", text: lines.join("\n") || "No agents." }] }
    }

    case "agentx_health": {
      const res = await fetch(`${DAEMON_URL}/health`)
      const data = await res.json() as any
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }
    }

    case "agentx_crons": {
      const res = await fetch(`${DAEMON_URL}/crons/health`)
      const data = await res.json() as any
      const summary = `Healthy: ${data.healthy}, Failing: ${data.failing}, Disabled: ${data.disabled}, Missed: ${data.missed}`
      const jobs = (data.jobs || []).map((j: any) =>
        `  ${j.id}: ${j.status}${j.consecutiveErrors ? ` (${j.consecutiveErrors} errors)` : ""}${j.lastError ? ` — ${j.lastError.slice(0, 100)}` : ""}`
      ).join("\n")
      return { content: [{ type: "text", text: `${summary}\n\n${jobs}` }] }
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
      const result = await agenticQuery(question, store, agentId, { maxHops })
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
        await fetch(`${DAEMON_URL}/debug/on?categories=${cats}`, { method: "POST" })
        return { content: [{ type: "text", text: `Debug enabled: ${cats}` }] }
      } else if (action === "off") {
        await fetch(`${DAEMON_URL}/debug/off`, { method: "POST" })
        return { content: [{ type: "text", text: "Debug disabled." }] }
      } else {
        const res = await fetch(`${DAEMON_URL}/debug`)
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

export async function startMcpServer(): Promise<void> {
  // Use stderr for logging (stdout is reserved for JSON-RPC)
  const log = (...args: unknown[]) => console.error("[agentx-mcp]", ...args)

  log("Starting MCP server (stdio transport)...")

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
          protocolVersion: PROTOCOL_VERSION,
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
        result: { tools: TOOLS },
      })
      break
    }

    case "tools/call": {
      const toolName = (params as any)?.name as string
      const toolArgs = ((params as any)?.arguments || {}) as Record<string, unknown>

      try {
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
