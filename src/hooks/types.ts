import { z } from "zod"

// --- Hook system types ---

export const HOOK_EVENTS = [
  "pre:generate",
  "post:generate",
  "pre:file-write",
  "post:file-write",
  "pre:prompt",
  "post:response",
  "pre:command",
  "on:error",
  "pre:tool-call",
  "post:tool-call",
  // Daemon events
  "pre:channel-message",
  "post:channel-message",
  "pre:a2a-task",
  "pre:cron-run",
  "post:cron-run",
  // GitLab-specific events (fired without agent routing — side-effect hooks
  // OR routing-modifying hooks that return `modified.dispatch` to pick the
  // agent(s) to run for this event).
  "on:gitlab-pipeline",
  "on:gitlab-issue",
  "on:gitlab-mr",
  "on:gitlab-note",
  // GitHub events — fired by the generic webhook handler after signature
  // verification. Workflow `trigger.hook` subscribers can subscribe.
  "on:github-issue",
  "on:github-pr",
  "on:github-push",
  // External-service events — fired by the generic webhook handler after
  // signature verification. Workflows subscribe via trigger.hook.
  "on:stripe-event",
  "on:sentry-issue",
  "on:vercel-deployment",
  "on:odoo-event",
  "on:hubspot-event",
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

// Which hooks can block (return { blocked: true } to cancel the operation)
export const BLOCKING_EVENTS: HookEvent[] = [
  "pre:generate",
  "pre:file-write",
  "pre:prompt",
  "post:response",
  "pre:command",
  "pre:tool-call",
  // Daemon blocking events
  "pre:channel-message",
  "post:channel-message",
  "pre:a2a-task",
  "pre:cron-run",
]

export type HookType = "command" | "prompt" | "script"

export const hookDefinitionSchema = z.object({
  name: z.string(),
  type: z.enum(["command", "prompt", "script"]),
  // For "command" type: shell command with {{variable}} interpolation
  command: z.string().optional(),
  // For "prompt" type: LLM prompt template
  prompt: z.string().optional(),
  // For "prompt" type: override provider/model for this hook
  provider: z.enum(["claude-code", "claude", "openai", "deepseek", "ollama", "custom"]).optional(),
  model: z.string().optional(),
  // For "script" type: path to JS/TS file exporting a handler
  script: z.string().optional(),
  // Hook priority (lower runs first, default 100)
  priority: z.number().default(100),
  // Whether this hook is enabled
  enabled: z.boolean().default(true),
})

export type HookDefinition = z.infer<typeof hookDefinitionSchema>

export interface HookContext {
  event: HookEvent
  // Data varies by event
  task?: string
  file?: string
  fileContent?: string
  content?: string
  command?: string
  error?: Error
  cwd?: string
  [key: string]: unknown
}

export interface HookResult {
  // If true, the operation is blocked/cancelled
  blocked?: boolean
  // Optional message explaining why it was blocked
  message?: string
  // Modified data to pass forward (e.g., modified file content)
  modified?: Record<string, unknown>
}

export type HookHandler = (context: HookContext) => Promise<HookResult>
