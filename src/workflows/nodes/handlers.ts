import { evaluateBranch, getByPath } from "../engine"
import { renderParams, render } from "../template"
import { formSchemaSchema, type FormSchema } from "../../forms/types"
import { parseAssigneeRef } from "../../actors/types"
import { nodeConcurrencyGate, nodeKey } from "../node-concurrency"
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

  // Optional per-node concurrency cap. When N runs of this workflow all
  // arrive at the same hot node, the gate serializes execution past N
  // active. Prevents the scenario where a burst of triggers fans out
  // every concurrent run to the same agent and multiplies token spend.
  const maxConcurrent = typeof cfg.maxConcurrent === "number" && cfg.maxConcurrent > 0
    ? cfg.maxConcurrent
    : null
  const gateKey = maxConcurrent ? nodeKey(ctx.workflow.id, ctx.node.id) : null
  if (gateKey && maxConcurrent) {
    const before = nodeConcurrencyGate.stats(gateKey)
    if (before.active >= maxConcurrent) {
      ctx.log(`[node:${ctx.node.id}] gated: ${before.active} active (cap ${maxConcurrent}), ${before.waiting + 1} waiting`)
    }
    await nodeConcurrencyGate.acquire(gateKey, maxConcurrent)
  }

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
  } finally {
    if (gateKey) nodeConcurrencyGate.release(gateKey)
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

/** Send a message via any channel adapter with a `send()` method.
 *
 *  Account inheritance: when `accountId` isn't set on this node, fall back to
 *  the trigger's `accountId` so workflow replies go out on the SAME bot the
 *  message arrived on. Without this, multi-account adapters (Telegram) would
 *  resolve the token via `chatAccountMap` — last bot to chat with the user —
 *  and the same agent's reply could leak through any of N bots depending on
 *  who messaged first. Authors can still override by setting `accountId`
 *  explicitly in the node config. */
const sendHandler: NodeHandler = async (ctx) => {
  const rendered = renderParams(ctx.node.config, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const channel = String(rendered.channel ?? "")
  const chatId = String(rendered.chatId ?? "")
  const text = String(rendered.text ?? "")
  if (!channel || !chatId) {
    // Surface which template source was empty — usually the culprit is an
    // unallowed env var or a typo in a {{node.path}} reference. Without
    // this the author sees only "needs channel + chatId" and has to dig.
    const rawChat = String((ctx.node.config as Record<string, unknown>).chatId ?? "")
    const rawChan = String((ctx.node.config as Record<string, unknown>).channel ?? "")
    const hints: string[] = []
    if (!channel) hints.push(`channel config="${rawChan}" rendered=""`)
    if (!chatId)  hints.push(`chatId config="${rawChat}" rendered=""`)
    if (/\{\{\s*env\./.test(rawChat) || /\{\{\s*env\./.test(rawChan)) {
      hints.push(`(env.* templates only resolve for names listed in workflow.envAllow and actually set in process.env)`)
    }
    return { error: `action.send "${ctx.node.id}" needs channel + chatId — ${hints.join("; ")}` }
  }

  const accountId = resolveAccountId(ctx, rendered.accountId)

  const adapter = ctx.channels[channel] as { send?: (m: { channel: string; chatId: string; text: string; accountId?: string }) => Promise<string | void> } | undefined

  // Local-first: if this node hosts the channel, send through the live
  // adapter. Otherwise fall back to the mesh forwarder (the channel may live
  // on a peer — workflow on macbook, whatsapp on clawd-server, etc.). Without
  // either, we hard-error rather than silently dropping.
  if (adapter?.send) {
    try {
      const messageId = await adapter.send({ channel, chatId, text, ...(accountId ? { accountId } : {}) })
      return { output: { messageId: messageId ?? null } }
    } catch (e: any) {
      return { error: `action.send failed: ${e.message}` }
    }
  }

  if (ctx.forwardChannelSend) {
    try {
      const r = await ctx.forwardChannelSend({ channel, chatId, text, accountId })
      return { output: { messageId: r.messageId, viaMesh: true } }
    } catch (e: any) {
      ctx.log(`[node:${ctx.node.id}] mesh-forward of "${channel}" send failed: ${e.message}`)
      return { error: `action.send via mesh failed: ${e.message}` }
    }
  }

  ctx.log(`[node:${ctx.node.id}] adapter "${channel}" not available locally and no mesh forwarder`)
  return { error: `channel "${channel}" not available (no local adapter, no mesh route)` }
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
      kind: "checkpoint",
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

  const accountId = resolveAccountId(ctx, rendered.accountId)
  const adapter = ctx.channels[channel] as { react?: (chatId: string, messageId: string, emoji?: string, accountId?: string) => Promise<void> } | undefined
  if (!adapter?.react) return { error: `channel "${channel}" does not support react` }
  try { await adapter.react(chatId, messageId, emoji, accountId); return { output: { emoji } } }
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

  const accountId = resolveAccountId(ctx, rendered.accountId)
  const adapter = ctx.channels[channel] as { editMessage?: (chatId: string, messageId: string, text: string, parseMode?: string, accountId?: string) => Promise<boolean> } | undefined
  if (!adapter?.editMessage) return { error: `channel "${channel}" does not support editMessage` }
  try {
    const ok = await adapter.editMessage(chatId, messageId, text, parseMode, accountId)
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

/** userTask: assign work to an actor or role, render a form to them, pause
 *  the run until POST /workflow/task/:taskId/submit. Task records live in
 *  the TaskStore so the inbox + channel renderers can find them. */
const userTaskHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const rendered = renderParams(cfg as Record<string, unknown>, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })

  const assigneeRaw = String(rendered.assignTo ?? "")
  if (!assigneeRaw) return { error: `userTask "${ctx.node.id}" missing config.assignTo` }
  const ref = parseAssigneeRef(assigneeRaw)
  if (!ref) return { error: `userTask "${ctx.node.id}" assignTo must be "actor:<id>" or "role:<id>", got "${assigneeRaw}"` }

  const formRaw = (cfg.form ?? rendered.form) as unknown
  const form = coerceForm(formRaw)
  if (!form) return { error: `userTask "${ctx.node.id}" missing or invalid config.form` }

  const title = String(rendered.title ?? form.title ?? ctx.node.id)
  const description = typeof rendered.description === "string" ? rendered.description : undefined

  if (!ctx.actors) return { error: `userTask "${ctx.node.id}" requires ActorStore in context (engine misconfigured)` }
  if (!ctx.tasks)  return { error: `userTask "${ctx.node.id}" requires TaskStore in context (engine misconfigured)` }

  const assignedTo = ctx.actors.pickAssignees(ref)
  if (assignedTo.length === 0) {
    return { error: `userTask "${ctx.node.id}" assignee "${assigneeRaw}" resolved to zero actors` }
  }

  const dueAt = computeDueAt(rendered.dueIn)

  const task = ctx.tasks.create({
    runId: ctx.run.id,
    workflowId: ctx.workflow.id,
    nodeId: ctx.node.id,
    title,
    description,
    assignee: assigneeRaw,
    assignedTo,
    form,
    dueAt,
  })

  ctx.log(`[node:${ctx.node.id}] userTask created ${task.id} for ${assigneeRaw} → actors [${assignedTo.join(", ")}]`)

  return {
    paused: true,
    pausedAt: {
      kind: "userTask",
      nodeId: ctx.node.id,
      taskId: task.id,
      assignee: assigneeRaw,
      assignedTo,
    },
  }
}

function coerceForm(raw: unknown): FormSchema | null {
  if (!raw || typeof raw !== "object") return null
  const parsed = formSchemaSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Convert an ISO-8601 duration ("PT2H", "P1D") or a plain number-of-minutes
 *  into an absolute dueAt timestamp. Accepts { minutes: N } too for convenience. */
function computeDueAt(dueIn: unknown): string | undefined {
  if (dueIn === undefined || dueIn === null) return undefined
  if (typeof dueIn === "number") return new Date(Date.now() + dueIn * 60_000).toISOString()
  if (typeof dueIn === "object" && dueIn && "minutes" in dueIn) {
    const m = Number((dueIn as { minutes: unknown }).minutes)
    if (Number.isFinite(m)) return new Date(Date.now() + m * 60_000).toISOString()
  }
  if (typeof dueIn === "string") {
    const match = /^P(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?)?$/.exec(dueIn)
    if (match) {
      const days = Number(match[1] ?? 0)
      const hours = Number(match[2] ?? 0)
      const minutes = Number(match[3] ?? 0)
      const seconds = Number(match[4] ?? 0)
      const ms = ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000
      if (ms > 0) return new Date(Date.now() + ms).toISOString()
    }
  }
  return undefined
}

/** subProcess: spawn a child workflow run, pause the parent until the child
 *  reaches `end`. Enforces workflow.maxChildDepth safety rail at spawn time.
 *  Actual spawn is performed by the dispatcher (walk loop observes
 *  `spawnChild` on the result and creates + kicks the child run). */
const subProcessHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const rendered = renderParams(cfg as Record<string, unknown>, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })

  const childWorkflowId = String(rendered.workflowId ?? "")
  if (!childWorkflowId) return { error: `subProcess "${ctx.node.id}" missing config.workflowId` }

  // Depth safety rail: parent at depth D may spawn children up to
  // maxChildDepth - 1. I.e. a cap of 5 allows depths 0..4 to spawn 1..5.
  const parentDepth = ctx.run.depth ?? 0
  const cap = ctx.workflow.maxChildDepth ?? 5
  if (parentDepth + 1 >= cap) {
    return { error: `max child workflow depth ${cap} exceeded at ${ctx.workflow.id} → ${childWorkflowId} (parent depth ${parentDepth})` }
  }

  // Compute the child's initial context from inputMap. Map top-level keys
  // are child-context keys (typically the child's trigger node id); values
  // are objects whose leaves are rendered via the template engine.
  const rawInputMap = cfg.inputMap as unknown
  let inputBundle: Record<string, Record<string, unknown>> = {}
  if (rawInputMap === "*") {
    inputBundle = { ...(ctx.run.context as Record<string, Record<string, unknown>>) }
  } else if (rawInputMap && typeof rawInputMap === "object") {
    for (const [k, v] of Object.entries(rawInputMap as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        inputBundle[k] = renderParams(v as Record<string, unknown>, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
      } else if (typeof v === "string") {
        inputBundle[k] = { value: render(v, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow }) }
      }
    }
  }

  return {
    paused: true,
    pausedAt: {
      kind: "subProcess",
      nodeId: ctx.node.id,
      childRunId: "",         // populated by dispatcher after spawn
      childWorkflowId,
    },
    spawnChild: { workflowId: childWorkflowId, input: inputBundle },
  }
}

/** trigger.form: same passthrough semantics as other triggers — the
 *  dispatcher seeds the trigger node's output from the incoming form
 *  submission when a run is created. */
const triggerFormHandler: NodeHandler = triggerHandler

/** signal.emit: side-effect node — post a signal to the bus. Walk loop
 *  reads `emitSignal` from the result and dispatches it before continuing. */
const signalEmitHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const rendered = renderParams(cfg as Record<string, unknown>, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const name = String(rendered.name ?? "")
  if (!name) return { error: `signal.emit "${ctx.node.id}" missing config.name` }
  const scope = rendered.scope === "global" ? "global" : "workflow"
  const payload = (rendered.payload && typeof rendered.payload === "object") ? rendered.payload as Record<string, unknown> : {}
  return {
    output: { emittedAt: new Date().toISOString(), name, scope, payload },
    emitSignal: { name, scope, payload },
  }
}

/** signal.wait: pause the run until a matching signal arrives. */
const signalWaitHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const rendered = renderParams(cfg as Record<string, unknown>, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const name = String(rendered.name ?? "")
  if (!name) return { error: `signal.wait "${ctx.node.id}" missing config.name` }
  const scope = rendered.scope === "global" ? "global" : "workflow"
  const match = (cfg.match && typeof cfg.match === "object") ? cfg.match as Record<string, unknown> : {}
  return {
    paused: true,
    pausedAt: {
      kind: "signalWait",
      nodeId: ctx.node.id,
      signalName: name,
      match,
      scope,
    },
  }
}

/** timer.boundary: pause the run until `after` elapses. The timer
 *  subsystem fires a resume event on fireAt. Used both for SLA escalation
 *  (attached to a prior node) and for intermediate waits. */
const timerBoundaryHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config
  const rendered = renderParams(cfg as Record<string, unknown>, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
  const due = computeDueAt(rendered.after ?? cfg.after)
  if (!due) return { error: `timer.boundary "${ctx.node.id}" needs config.after (duration or minutes)` }
  return {
    paused: true,
    pausedAt: {
      kind: "timerWait",
      nodeId: ctx.node.id,
      fireAt: due,
    },
  }
}

/** gateway.parallel: v1 is a passthrough. Multi-branch join semantics
 *  land in Phase 2 when the walk driver upgrades to concurrent-pending. */
const gatewayParallelHandler: NodeHandler = async () => ({ output: {} })

/** DMN-style decision-table rule node.
 *
 *  Config shape:
 *    {
 *      inputs: ["{{path.a}}", "{{path.b}}", ...]   // N templated values
 *      rules:  [
 *        { when: ["*", "gold", ">100"], to: "vip",    output: { tier: "gold" } },
 *        { when: ["nike", "*", "*"],     to: "oem",    output: { brand: "nike" } },
 *        ...
 *      ],
 *      default: { to: "fallback", output: {} }
 *    }
 *
 *  Each `when` cell matches the corresponding input by one of:
 *    - "*"            → wildcard (matches anything)
 *    - "value"        → exact string equality
 *    - ">N" / "<N"    → numeric comparison
 *    - ">=N" / "<=N"  → numeric comparison
 *    - "!=value"      → inequality
 *    - "/regex/"      → regex match
 *
 *  First matching row wins. Falls through to `default` when no rule matches. */
const ruleHandler: NodeHandler = async (ctx) => {
  const cfg = ctx.node.config as {
    inputs?: unknown
    rules?: Array<{ when?: unknown; to?: string; output?: Record<string, unknown> }>
    default?: { to?: string; output?: Record<string, unknown> }
  }
  const inputTemplates = Array.isArray(cfg.inputs) ? cfg.inputs as unknown[] : []
  const inputs = inputTemplates.map((raw) =>
    typeof raw === "string"
      ? render(raw, ctx.run.context as unknown as Record<string, unknown>, { envAllow: ctx.workflow.envAllow })
      : raw
  )
  const rules = Array.isArray(cfg.rules) ? cfg.rules : []
  for (const rule of rules) {
    const when = Array.isArray(rule.when) ? rule.when as unknown[] : []
    if (when.length !== inputs.length) continue
    let all = true
    for (let i = 0; i < when.length; i++) {
      if (!matchCell(when[i], inputs[i])) { all = false; break }
    }
    if (all) {
      return {
        output: { ...(rule.output ?? {}), matchedPort: rule.to ?? "" },
        port: rule.to,
      }
    }
  }
  const def = cfg.default
  return {
    output: { ...(def?.output ?? {}), matchedPort: def?.to ?? "" },
    port: def?.to,
  }
}

function matchCell(when: unknown, input: unknown): boolean {
  if (when === undefined || when === null || when === "*") return true
  const w = String(when)
  const v = typeof input === "number" ? input : String(input ?? "")
  // Numeric comparators
  const numMatch = /^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/.exec(w)
  if (numMatch) {
    const op = numMatch[1], n = Number(numMatch[2])
    const vNum = typeof v === "number" ? v : Number(v)
    if (Number.isNaN(vNum)) return false
    switch (op) {
      case ">":  return vNum > n
      case "<":  return vNum < n
      case ">=": return vNum >= n
      case "<=": return vNum <= n
    }
  }
  if (w.startsWith("!=")) return String(v) !== w.slice(2)
  if (w.startsWith("/") && w.endsWith("/") && w.length > 2) {
    try { return new RegExp(w.slice(1, -1)).test(String(v)) } catch { return false }
  }
  return String(v) === w
}

// --- Registry ---

export const NODE_HANDLERS: Record<string, NodeHandler> = {
  "trigger.channel": triggerHandler,
  "trigger.manual":  triggerHandler,
  "trigger.cron":    triggerHandler,
  "trigger.hook":    triggerHandler,
  "trigger.form":    triggerFormHandler,
  "agent":           agentHandler,
  "branch":          branchHandler,
  "transform":       transformHandler,
  "gateway.parallel": gatewayParallelHandler,
  "rule":            ruleHandler,
  "action.send":        sendHandler,
  "action.createIssue": createIssueHandler,
  "action.setLabel":    setLabelHandler,
  "action.readLabel":   readLabelHandler,
  "action.react":       reactHandler,
  "action.editMessage": editMessageHandler,
  "action.logTime":     logTimeHandler,
  "action.callHTTP":    callHTTPHandler,
  "userTask":        userTaskHandler,
  "subProcess":      subProcessHandler,
  "signal.emit":     signalEmitHandler,
  "signal.wait":     signalWaitHandler,
  "timer.boundary":  timerBoundaryHandler,
  "checkpoint":      checkpointHandler,
  "end":             endHandler,
}

export function resolveHandler(type: string): NodeHandler | undefined {
  return NODE_HANDLERS[type]
}

// --- Helpers ---

/** Resolve the accountId for a channel-action node. Explicit config wins; if
 *  unset, inherit from the trigger payload so workflow replies stay on the
 *  same bot/account that received the inbound message. Returns undefined when
 *  neither is available — adapters that don't care about accountId (single-
 *  account channels) handle it transparently. */
function resolveAccountId(ctx: NodeContext, explicit: unknown): string | undefined {
  if (typeof explicit === "string" && explicit) return explicit
  const triggerNode = ctx.workflow.nodes.find((n) => n.type.startsWith("trigger."))
  if (!triggerNode) return undefined
  const trigger = ctx.run.context[triggerNode.id] as { accountId?: unknown } | undefined
  const fromTrigger = trigger?.accountId
  return typeof fromTrigger === "string" && fromTrigger ? fromTrigger : undefined
}

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
