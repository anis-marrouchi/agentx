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
}

// Default daemon URL (local)
const DAEMON_URL = process.env.AGENTX_DAEMON_URL || "http://localhost:19900"

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
    name: "agentx_send",
    description:
      "Send a message to any channel (Telegram, WhatsApp, GitLab, Discord). Use for cross-channel notifications, proactive outbound messages, or relaying information between channels.",
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

    case "agentx_send": {
      const res = await fetch(`${DAEMON_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: args.channel,
          chatId: args.chatId,
          text: args.text,
          agentId: args.agentId,
        }),
      })
      const data = await res.json() as any
      if (!res.ok) {
        return { content: [{ type: "text", text: `Error: ${data.error || res.statusText}` }] }
      }
      return { content: [{ type: "text", text: `Message sent. ID: ${data.messageId || "ok"}` }] }
    }

    case "agentx_task": {
      const res = await fetch(`${DAEMON_URL}/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: args.agent, message: args.message }),
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

export async function startMcpServer(): Promise<void> {
  // Use stderr for logging (stdout is reserved for JSON-RPC)
  const log = (...args: unknown[]) => console.error("[agentx-mcp]", ...args)

  log("Starting MCP server (stdio transport)...")

  let buffer = ""

  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk

    // Process complete messages (Content-Length header based)
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n")
      if (headerEnd === -1) break

      const header = buffer.slice(0, headerEnd)
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/)
      if (!contentLengthMatch) {
        // Try without header (some clients send raw JSON)
        const newlineIdx = buffer.indexOf("\n")
        if (newlineIdx === -1) break

        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)

        if (line) {
          try {
            const msg = JSON.parse(line)
            handleMessage(msg, log).catch((e) => log("Error:", e))
          } catch {
            // Not valid JSON, skip
          }
        }
        continue
      }

      const contentLength = parseInt(contentLengthMatch[1], 10)
      const bodyStart = headerEnd + 4
      const bodyEnd = bodyStart + contentLength

      if (buffer.length < bodyEnd) break // Need more data

      const body = buffer.slice(bodyStart, bodyEnd)
      buffer = buffer.slice(bodyEnd)

      try {
        const msg = JSON.parse(body)
        handleMessage(msg, log).catch((e) => log("Error:", e))
      } catch (e) {
        log("Failed to parse message:", e)
      }
    }
  })

  process.stdin.on("end", () => {
    log("stdin closed, shutting down.")
    process.exit(0)
  })
}

function send(message: JsonRpcResponse | JsonRpcNotification): void {
  const body = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
  process.stdout.write(header + body)
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
