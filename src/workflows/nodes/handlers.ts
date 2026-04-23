import { evaluateBranch, getByPath } from "../engine"
import { renderParams, render } from "../template"
import type { NodeContext, NodeHandler, NodeResult } from "./types"

// --- Node handlers (Phase 1 set) ---
//
// Phase 1 ships: trigger.* (passthrough), agent, branch, action.send,
// action.createIssue, end. Phase 2 adds checkpoint + label verbs.
// Phase 3 adds react / editMessage / logTime / callHTTP / createCard /
// trigger.cron / trigger.hook / trigger.manual specialisations.
//
// Each handler validates the shape of `node.config` locally and narrows the
// channel adapter it needs to just the method it calls. Failures log and
// return { error }; the dispatcher converts that into a failed-run state.

/** Trigger nodes' output is pre-seeded into `run.context[triggerId]` by the
 *  dispatcher when the run is created — they never actually "execute" here.
 *  This handler is just a passthrough for completeness. */
const triggerHandler: NodeHandler = async (ctx) => {
  const output = ctx.run.context[ctx.node.id] ?? {}
  return { output }
}

const agentHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const agentId = String(cfg.agentId ?? "")
  const promptTemplate = String(cfg.prompt ?? "")
  if (!agentId) return { error: `agent node "${ctx.node.id}" missing config.agentId` }

  const prompt = render(promptTemplate, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const timeoutMinutes = typeof cfg.timeoutMinutes === "number" ? cfg.timeoutMinutes : undefined
  const start = Date.now()
  try {
    const resp = await ctx.agents.execute({
      agentId,
      message: prompt,
      workflowRunId: ctx.run.id,
      timeoutMinutes,
    })
    const durationMs = Date.now() - start
    if (resp.error) {
      ctx.log(`[node:${ctx.node.id}] agent "${agentId}" failed: ${resp.error}`)
      return { error: resp.error }
    }
    const parser = String(cfg.resultParser ?? "noqta-result-token")
    const parsed = parser === "json" ? extractJsonBlock(resp.content) : parseResultToken(resp.content)
    return {
      output: {
        reply: resp.content,
        result: parsed.result,
        json: parsed.json,
        taskId: resp.taskId,
        durationMs,
      },
    }
  } catch (e: any) {
    ctx.log(`[node:${ctx.node.id}] agent "${agentId}" threw: ${e.message}`)
    return { error: e.message }
  }
}

const branchHandler: NodeHandler = async (ctx) => {
  const port = evaluateBranch(ctx.node, ctx.run.context as unknown as Record<string, unknown>)
  if (!port) {
    ctx.log(`[node:${ctx.node.id}] branch matched no case and no default port`)
    return { output: { port: null } }
  }
  return { output: { port }, port }
}

/** Send a message via any channel adapter with a `send()` method. */
const sendHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "")
  const chatId = String(rendered.chatId ?? "")
  const text = String(rendered.text ?? "")
  if (!channel || !chatId) return { error: `action.send "${ctx.node.id}" needs channel + chatId` }

  const adapter = ctx.channels[channel] as { send?: (m: { channel: string; chatId: string; text: string }) => Promise<string | void> } | undefined
  if (!adapter?.send) {
    ctx.log(`[node:${ctx.node.id}] adapter "${channel}" not available or missing send()`)
    return { error: `channel "${channel}" not available` }
  }
  try {
    const messageId = await adapter.send({ channel, chatId, text })
    return { output: { messageId: messageId ?? null } }
  } catch (e: any) {
    return { error: `action.send failed: ${e.message}` }
  }
}

/** Create an issue via the GitLab adapter's createIssue method. */
const createIssueHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "gitlab")
  const project = String(rendered.project ?? "")
  const title = String(rendered.title ?? "")
  const description = String(rendered.description ?? "")
  const labels = Array.isArray(rendered.labels) ? (rendered.labels as string[]).map(String) : []
  const assignees = Array.isArray(rendered.assignees) ? (rendered.assignees as string[]).map(String) : []
  if (!project || !title) return { error: `action.createIssue "${ctx.node.id}" needs project + title` }

  // Resolve the originating agent id (if any) from the most recent upstream
  // agent-node execution, so per-agent token identity is preserved.
  const agentId = findUpstreamAgentId(ctx)

  const adapter = ctx.channels[channel] as {
    createIssue?: (args: {
      project: string; title: string; description?: string;
      labels?: string[]; assignees?: string[]; agentId?: string
    }) => Promise<{ iid: number; url: string } | null>
  } | undefined
  if (!adapter?.createIssue) {
    return { error: `channel "${channel}" does not support createIssue` }
  }
  try {
    const result = await adapter.createIssue({ project, title, description, labels, assignees, agentId })
    if (!result) return { error: "createIssue returned null (see adapter log)" }
    return {
      output: {
        issue: {
          iid: result.iid,
          url: result.url,
          webUrl: result.url,
        },
      },
    }
  } catch (e: any) {
    return { error: `action.createIssue failed: ${e.message}` }
  }
}

const endHandler: NodeHandler = async () => ({ output: {} })

/** Checkpoint: pauses the run with a named state + a resume filter.  When an
 *  event matching the filter arrives later (webhook, manual), the dispatcher
 *  resumes the run by enqueueing the checkpoint's successors and seeding the
 *  incoming event as this node's output. */
const checkpointHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const name = String(cfg.name ?? ctx.node.id)
  const waitFor = (cfg.waitFor ?? {}) as Record<string, unknown>
  const resumeMatch = (cfg.resumeMatch ?? {}) as Record<string, unknown>
  return {
    paused: true,
    pausedAt: {
      nodeId: ctx.node.id,
      checkpointName: name,
      // Consolidate waitFor + resumeMatch: when a future event arrives on
      // this run's entity, it's compared to both. waitFor is the canonical
      // shape (it mirrors a trigger.channel filter); resumeMatch is an
      // escape hatch for custom matches on event payload fields.
      resumeMatch: { ...waitFor, ...resumeMatch },
    },
  }
}

/** Action.setLabel: add / remove labels on a GitLab issue or MR. Looks up
 *  the project + iid from the config; defaults to `{{trigger.project}}` +
 *  `{{trigger.issue.iid}}` when those exist in the run context. */
const setLabelHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "gitlab")
  const project = String(rendered.project ?? "")
  const iid = String(rendered.iid ?? "")
  const add = Array.isArray(rendered.add) ? (rendered.add as string[]).map(String) : []
  const remove = Array.isArray(rendered.remove) ? (rendered.remove as string[]).map(String) : []
  if (!project || !iid) return { error: `action.setLabel "${ctx.node.id}" needs project + iid (try {{trigger.project}} / {{trigger.issue.iid}})` }
  if (add.length === 0 && remove.length === 0) return { output: { skipped: true, reason: "no labels to add or remove" } }

  const adapter = ctx.channels[channel] as {
    setLabels?: (a: { project: string; kind?: "issue" | "merge_request"; iid: string; add?: string[]; remove?: string[]; agentId?: string }) => Promise<string[] | null>
  } | undefined
  if (!adapter?.setLabels) return { error: `channel "${channel}" does not support setLabels` }

  const agentId = findUpstreamAgentId(ctx)
  const kind = (rendered.kind === "merge_request" ? "merge_request" : "issue") as "issue" | "merge_request"
  const labels = await adapter.setLabels({ project, kind, iid, add, remove, agentId })
  return { output: { labels: labels ?? [], add, remove } }
}

/** Action.readLabel: fetch the current labels on an issue/MR so downstream
 *  nodes can branch on them. Emits `{ labels: string[] }` to the run context. */
const readLabelHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "gitlab")
  const project = String(rendered.project ?? "")
  const iid = String(rendered.iid ?? "")
  if (!project || !iid) return { error: `action.readLabel "${ctx.node.id}" needs project + iid` }

  const adapter = ctx.channels[channel] as {
    getLabels?: (a: { project: string; kind?: "issue" | "merge_request"; iid: string }) => Promise<string[] | null>
  } | undefined
  if (!adapter?.getLabels) return { error: `channel "${channel}" does not support getLabels` }

  const kind = (rendered.kind === "merge_request" ? "merge_request" : "issue") as "issue" | "merge_request"
  const labels = await adapter.getLabels({ project, kind, iid })
  return { output: { labels: labels ?? [] } }
}

/** Action.react: add an emoji reaction via the adapter's `react()` method.
 *  Telegram + WhatsApp implement it; others return "not supported". */
const reactHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "")
  const chatId = String(rendered.chatId ?? "")
  const messageId = String(rendered.messageId ?? "")
  const emoji = String(rendered.emoji ?? "👀")
  if (!channel || !chatId || !messageId) return { error: `action.react "${ctx.node.id}" needs channel + chatId + messageId` }

  const adapter = ctx.channels[channel] as { react?: (chatId: string, messageId: string, emoji?: string) => Promise<void> } | undefined
  if (!adapter?.react) return { error: `channel "${channel}" does not support react` }
  try { await adapter.react(chatId, messageId, emoji); return { output: { emoji } } }
  catch (e: any) { return { error: `action.react failed: ${e.message}` } }
}

/** Action.editMessage: edit a previously-sent message in place. */
const editMessageHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "")
  const chatId = String(rendered.chatId ?? "")
  const messageId = String(rendered.messageId ?? "")
  const text = String(rendered.text ?? "")
  const parseMode = rendered.parseMode ? String(rendered.parseMode) : undefined
  if (!channel || !chatId || !messageId || !text) return { error: `action.editMessage "${ctx.node.id}" needs channel + chatId + messageId + text` }

  const adapter = ctx.channels[channel] as { editMessage?: (chatId: string, messageId: string, text: string, parseMode?: string) => Promise<boolean> } | undefined
  if (!adapter?.editMessage) return { error: `channel "${channel}" does not support editMessage` }
  try {
    const ok = await adapter.editMessage(chatId, messageId, text, parseMode)
    return { output: { edited: ok } }
  } catch (e: any) { return { error: `action.editMessage failed: ${e.message}` } }
}

/** Action.logTime: record time spent. Currently GitLab only — wraps the
 *  adapter's logTimeSpent(chatId, durationMs, agentId?). The chatId
 *  convention is "project:issue:iid" or "project:merge_request:iid". */
const logTimeHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "gitlab")
  const chatId = String(rendered.chatId ?? "")
  const durationMs = Number(rendered.durationMs ?? 0)
  if (!chatId || !durationMs) return { error: `action.logTime "${ctx.node.id}" needs chatId + durationMs` }

  const adapter = ctx.channels[channel] as { logTimeSpent?: (chatId: string, durationMs: number, agentId?: string) => Promise<void> } | undefined
  if (!adapter?.logTimeSpent) return { error: `channel "${channel}" does not support logTimeSpent` }
  const agentId = findUpstreamAgentId(ctx)
  try {
    await adapter.logTimeSpent(chatId, durationMs, agentId)
    return { output: { durationMs } }
  } catch (e: any) { return { error: `action.logTime failed: ${e.message}` } }
}

/** Action.callHTTP: generic outbound request with templated params. Body is
 *  rendered as a string (authors write JSON templates) or passed straight
 *  if already an object. Response body is captured as `{ status, body }`
 *  so downstream nodes can branch on it. */
const callHTTPHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const url = String(rendered.url ?? "")
  if (!url) return { error: `action.callHTTP "${ctx.node.id}" needs url` }
  const method = String(rendered.method ?? "POST").toUpperCase()
  const headers = (rendered.headers && typeof rendered.headers === "object")
    ? rendered.headers as Record<string, string>
    : { "Content-Type": "application/json" }
  let body: string | undefined
  if (rendered.body !== undefined) {
    body = typeof rendered.body === "string" ? rendered.body : JSON.stringify(rendered.body)
  }

  try {
    const res = await fetch(url, { method, headers, body })
    // Prefer parsed JSON, fall back to text.
    const rawText = await res.text()
    let parsed: unknown = rawText
    try { parsed = JSON.parse(rawText) } catch { /* leave as text */ }
    return {
      output: {
        ok: res.ok,
        status: res.status,
        body: parsed,
      },
    }
  } catch (e: any) {
    return { error: `action.callHTTP failed: ${e.message}` }
  }
}

/** Transform: derive a bundle from upstream context. V2 scope is tight — we
 *  support two modes:
 *    1. `path`: pick a value from context by dotted path, expose as {value}
 *    2. `template`: render each key via the template engine so authors can
 *       reshape + combine upstream outputs for the next node. */
const transformHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const ctxObj = ctx.run.context as unknown as Record<string, unknown>
  if (typeof cfg.path === "string" && cfg.path) {
    return { output: { value: getByPath(ctxObj, cfg.path) } }
  }
  if (cfg.template && typeof cfg.template === "object") {
    const rendered = renderParams(cfg.template as Record<string, unknown>, ctxObj, { envAllow: ctx.workflow.envAllow })
    return { output: rendered }
  }
  return { output: {} }
}

// --- Registry ---

export const NODE_HANDLERS: Record<string, NodeHandler> = {
  "trigger.channel": triggerHandler,
  "trigger.manual":  triggerHandler,
  "trigger.cron":    triggerHandler,
  "trigger.hook":    triggerHandler,
  "agent":           agentHandler,
  "branch":          branchHandler,
  "transform":       transformHandler,
  "action.send":        sendHandler,
  "action.createIssue": createIssueHandler,
  "action.setLabel":    setLabelHandler,
  "action.readLabel":   readLabelHandler,
  "action.react":       reactHandler,
  "action.editMessage": editMessageHandler,
  "action.logTime":     logTimeHandler,
  "action.callHTTP":    callHTTPHandler,
  "checkpoint":      checkpointHandler,
  "end":             endHandler,
}

export function resolveHandler(type: string): NodeHandler | undefined {
  return NODE_HANDLERS[type]
}

// --- Helpers ---

/** Look back through the run's history for the most recently-executed
 *  `agent` node and return its agentId. Used to attribute downstream
 *  side effects (issue creation, labels, time logs) to the same agent. */
function findUpstreamAgentId(ctx: NodeContext): string | undefined {
  for (let i = ctx.run.history.length - 1; i >= 0; i--) {
    const entry = ctx.run.history[i]
    const node = ctx.workflow.nodes.find((n) => n.id === entry.nodeId)
    if (node?.type === "agent") {
      return (node.config.agentId as string | undefined) ?? undefined
    }
  }
  return undefined
}

/** Agent contract: the reply MAY include a line like `RESULT: approved` or
 *  `[APPROVED]` to signal a workflow result. Same parser as the V1 engine
 *  (src/daemon/index.ts::parseAgentResult), lifted here so node handlers
 *  don't depend on daemon code. */
function parseResultToken(content: string | undefined): { result?: string; json?: unknown } {
  if (!content) return {}
  const explicit = content.match(/\bRESULT:\s*([a-z][a-z0-9_-]*)/i)
  if (explicit) return { result: explicit[1].toLowerCase() }
  const bracket = content.match(/\[(APPROVED|REJECTED|CHANGES[-_]REQUESTED|DONE|FAILED|SKIPPED)\]/i)
  if (bracket) return { result: bracket[1].toLowerCase().replace("_", "-") }
  return {}
}

/** Extract the first fenced ```json ... ``` block and the RESULT: token.
 *  Used when a workflow asks the agent for structured output (e.g. draft
 *  issue title + body alongside a classification). */
function extractJsonBlock(content: string | undefined): { result?: string; json?: unknown } {
  const { result } = parseResultToken(content)
  if (!content) return { result }
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (!m) return { result }
  try { return { result, json: JSON.parse(m[1]) } } catch { return { result } }
}
