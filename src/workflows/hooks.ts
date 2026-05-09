import type { HookContext, HookEvent, HookResult } from "@/hooks/types"
import type { IncomingMessage } from "@/channels/types"
import type { WorkflowDispatcher } from "./dispatcher"
import type { EntityRef } from "./types"

// --- Workflow hook subscribers (V2) ---
//
// Thin mappers: take whatever raw payload a hook fires with, produce a
// typed trigger bundle, and call the dispatcher. No routing decisions
// here — the dispatcher picks matching workflows, the engine walks the
// DAG, node handlers do the work.
//
// For channel-triggered workflows, the subscriber returns
// { blocked: true } when the event is claimed by a workflow so the router
// skips its default agent reply — otherwise BOTH the workflow's action.send
// AND the router's own reply would fire, producing duplicate messages.
// GitLab/pipeline subscribers stay non-blocking because those events run
// side-by-side with agent routing by design.
//
// A workflow can opt out per-trigger with `trigger.config.passthrough = true`
// to let the default router reply alongside the workflow (useful for
// observability-only workflows that just log or tag).

export function createWorkflowHookHandlers(dispatcher: WorkflowDispatcher): Partial<Record<HookEvent, (ctx: HookContext) => Promise<HookResult>>> {
  return {
    // Generic inbound channel message — WhatsApp, Telegram, Discord, Slack.
    // The router fires this before resolving an agent, so workflows see the
    // message with full structured detail (sender, group, media, etc.).
    "pre:channel-message": async (ctx) => {
      const msg = ctx.msg as IncomingMessage | undefined
      if (!msg) return {}
      const source = channelToTriggerSource(msg.channel)
      if (!source) return {}

      const chatId = msg.group?.id ?? msg.sender.id
      const entityRef: EntityRef = { backend: msg.channel, id: `${msg.channel}:${chatId}` }

      const { claimed } = await dispatcher.dispatch({
        trigger: {
          source,
          chat: chatId,
        },
        entityRef,
        event: {
          id: `${msg.channel}:${msg.accountId}:${msg.id}`,
          payload: buildChannelTriggerPayload(msg),
        },
      })

      if (claimed.length === 0) return {}

      // Opt-out: if every matched workflow declared `passthrough: true` on its
      // trigger node, let the router's default reply run alongside. Otherwise
      // the workflow owns the conversation — block the router.
      const allPassthrough = claimed.every((wf) => {
        const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
        return (trigger?.config as { passthrough?: boolean } | undefined)?.passthrough === true
      })
      if (allPassthrough) return {}

      return {
        blocked: true,
        message: `handled by workflow${claimed.length > 1 ? "s" : ""}: ${claimed.map((w) => w.id).join(", ")}`,
      }
    },

    // GitLab issue events — open, update, close. Existing subscriber shape
    // from V1 is preserved so the GitLab adapter doesn't need changes.
    "on:gitlab-issue": async (ctx) => {
      const project = ctx.project as string | undefined
      const iid = ctx.iid as string | number | undefined
      const issueEvent = ctx.issueEvent as any
      if (!project || iid === undefined) return {}

      const labels: string[] = Array.isArray(issueEvent?.object_attributes?.labels)
        ? issueEvent.object_attributes.labels.map((l: any) => typeof l === "string" ? l : l?.title).filter(Boolean)
        : (issueEvent?.labels?.map((l: any) => l?.title) ?? [])
      const assignees = issueEvent?.assignees ?? issueEvent?.object_attributes?.assignee_ids ?? []

      const entityRef: EntityRef = { backend: "gitlab", id: `${project}#${iid}` }
      await dispatcher.dispatch({
        trigger: { source: "gitlab-issue", project, labels },
        entityRef,
        event: {
          id: `gitlab-issue:${project}:${iid}:${issueEvent?.object_attributes?.updated_at || issueEvent?.object_attributes?.action || "evt"}`,
          payload: {
            issue: {
              iid,
              title: issueEvent?.object_attributes?.title,
              description: issueEvent?.object_attributes?.description,
              url: issueEvent?.object_attributes?.url,
              action: issueEvent?.object_attributes?.action,
              labels,
              assignees,
            },
            project,
            channel: "gitlab",
            chatId: `${project}:issue:${iid}`,
          },
        },
      })
      return {}
    },

    // GitLab MR events — open, reopen, update, approved, merge, close.
    // Mirrors on:gitlab-issue; the gitlab adapter fires this in handleMR
    // after the project rule's merge_request clause has approved the
    // event. Workflow subscribers see the typed mr payload and can route
    // off attrs.action (e.g. fire a review on `open`, fire deploy on
    // `merge`).
    "on:gitlab-mr": async (ctx) => {
      const project = ctx.project as string | undefined
      const iid = ctx.iid as string | number | undefined
      const mrEvent = ctx.mrEvent as any
      if (!project || iid === undefined) return {}

      const labels: string[] = Array.isArray(ctx.labels)
        ? (ctx.labels as string[])
        : (Array.isArray(mrEvent?.object_attributes?.labels)
            ? mrEvent.object_attributes.labels.map((l: any) => typeof l === "string" ? l : l?.title).filter(Boolean)
            : [])
      const assignees = mrEvent?.assignees ?? mrEvent?.object_attributes?.assignee_ids ?? []
      const reviewers = mrEvent?.reviewers ?? []

      const entityRef: EntityRef = { backend: "gitlab", id: `${project}!${iid}` }
      await dispatcher.dispatch({
        trigger: { source: "gitlab-mr", project, labels },
        entityRef,
        event: {
          id: `gitlab-mr:${project}:${iid}:${mrEvent?.object_attributes?.updated_at || mrEvent?.object_attributes?.action || "evt"}`,
          payload: {
            mr: {
              iid,
              title: ctx.title,
              description: ctx.description,
              url: ctx.url,
              action: ctx.action,
              state: ctx.state,
              source_branch: ctx.source_branch,
              target_branch: ctx.target_branch,
              labels,
              assignees,
              reviewers,
            },
            project,
            channel: "gitlab",
            chatId: `${project}:merge_request:${iid}`,
            iid,
            title: ctx.title,
            description: ctx.description,
            url: ctx.url,
            action: ctx.action,
            state: ctx.state,
            source_branch: ctx.source_branch,
            target_branch: ctx.target_branch,
            labels,
          },
        },
      })
      return {}
    },

    // GitLab note events — comments on issues / MRs / commits. Mirrors
    // on:gitlab-mr; the gitlab adapter fires this in handleNote AFTER the
    // project rule's note clause has approved the event AND cascade-
    // prevention checks (AgentX marker, sentNoteIds, isBotUser) have
    // passed. Workflow subscribers can branch off mentions / noteableType
    // (e.g. mr-fix-loop fires on noteableType=merge_request when a
    // reviewer's comment matches a request-changes pattern).
    "on:gitlab-note": async (ctx) => {
      const project = ctx.project as string | undefined
      const noteId = ctx.noteId as string | undefined
      const noteableType = ctx.noteableType as string | undefined
      const noteableIid = ctx.noteableIid as string | undefined
      const text = ctx.text as string | undefined
      const author = ctx.authorUsername as string | undefined
      const mentions = (ctx.mentions ?? []) as string[]
      if (!project || !noteId || !noteableType || !noteableIid) return {}

      const entityRef: EntityRef =
        noteableType === "merge_request"
          ? { backend: "gitlab", id: `${project}!${noteableIid}` }
          : { backend: "gitlab", id: `${project}#${noteableIid}` }

      await dispatcher.dispatch({
        // The trigger field carries only structural matchers; per-event
        // payload (mentions, etc.) lives in `event.payload`. Workflows
        // that need to filter on mentions look at `{{trigger.mentions}}`
        // resolved from the payload, not from this trigger object.
        trigger: { source: "gitlab-note", project },
        entityRef,
        event: {
          id: `gitlab-note:${project}:${noteableType}:${noteableIid}:${noteId}`,
          payload: {
            note: {
              id: noteId,
              text,
              author,
              mentions,
              noteableType,
              noteableIid,
              noteableTitle: ctx.noteableTitle,
            },
            project,
            channel: "gitlab",
            chatId: `${project}:${noteableType}:${noteableIid}`,
            noteId,
            noteableType,
            noteableIid,
            text,
            author,
            mentions,
          },
        },
      })
      return {}
    },

    // GitLab pipeline events (success / failed / canceled). Scoped to
    // MR-linked pipelines — pushes to branches without an MR don't enter
    // the workflow dispatcher.
    "on:gitlab-pipeline": async (ctx) => {
      const project = ctx.project as string | undefined
      const pipelineId = ctx.pipelineId as string | number | undefined
      const status = ctx.status as string | undefined
      const ref = ctx.ref as string | undefined
      if (!project || !status) return {}

      const raw = ctx.raw as any
      const mrIid = raw?.merge_request?.iid
      if (!mrIid) return {}

      const entityRef: EntityRef = { backend: "gitlab", id: `${project}!${mrIid}` }
      await dispatcher.dispatch({
        trigger: { source: "gitlab-pipeline", project },
        entityRef,
        event: {
          id: `gitlab-pipeline:${project}:${pipelineId}:${status}`,
          payload: {
            pipeline: { id: pipelineId, status, ref },
            project,
            channel: "gitlab",
            chatId: `${project}:merge_request:${mrIid}`,
          },
        },
      })
      return {}
    },
  }
}

function channelToTriggerSource(channel: string): string | null {
  switch (channel) {
    case "telegram":    return "telegram-message"
    case "whatsapp":    return "whatsapp-message"
    case "discord":     return "discord-message"
    case "slack":       return "slack-message"
    default:            return null
  }
}

function buildChannelTriggerPayload(msg: IncomingMessage): Record<string, unknown> {
  const chatId = msg.group?.id ?? msg.sender.id
  return {
    channel: msg.channel,
    chatId,
    accountId: msg.accountId,
    text: msg.text,
    fromJid: msg.sender.id,
    sender: {
      id: msg.sender.id,
      name: msg.sender.name,
      username: msg.sender.username,
    },
    contact: msg.channelMeta?.facts ? { facts: msg.channelMeta.facts } : undefined,
    group: msg.group ? { id: msg.group.id, name: msg.group.name } : undefined,
    channelMeta: msg.channelMeta,
    replyTo: msg.replyTo,
    replyToText: msg.replyToText,
    media: msg.media,
    event: { id: msg.id, timestamp: msg.timestamp?.toISOString?.() ?? new Date().toISOString() },
  }
}
