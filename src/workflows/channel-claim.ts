import type { IncomingMessage } from "@/channels/types"
import { normalizeChat } from "@/situations/normalize-chat"
import type { EntityRef, PausedAt, Workflow, WorkflowRun } from "./types"

// --- Who takes a channel message: the dispatcher's rule, in one place (#1892) ---
//
// The workflow dispatcher decides, for a channel message, whether a run
// takes it: a run waiting for a reply (person.wait), or a run of a
// channel-triggered workflow on the chat (forwarded to its home node,
// resumed from a checkpoint, already running, or started). The courtesy
// gate in the router asks the same question before the message reaches
// the dispatcher. Both read the rule from here, so they cannot disagree.
// Everything in this file is pure: the callers do the reads and the acts.

export interface TriggerFields { source: string; project?: string; repo?: string; chat?: string; labels?: string[] }

/** The trigger event a channel message becomes (id + payload). */
export interface ChannelTriggerEvent { id: string; payload: Record<string, unknown> }

/** What `dispatchOneLegacy` does with an event for one workflow, decided
 *  from the entity's state alone. */
export type ChannelVerdict =
  | "forward"          // active run homed on a peer, forwarder present: claimed
  | "no-forwarder"     // active run homed on a peer, no forwarder: not claimed
  | "start"            // no active run (or the index points at a run that is gone), trigger node present
  | "no-trigger"       // no active run, the workflow has no trigger node
  | "paused-other"     // paused, not on a checkpoint
  | "resume-mismatch"  // paused on a checkpoint, resumeMatch says no
  | "resume"           // paused on a checkpoint, resumeMatch says yes
  | "running"          // running: the concurrent event is claimed and dropped
  | "dead"             // completed, failed, canceled, or paused without pausedAt

export interface ChannelClaimState {
  activeRunId: string | null
  run: Pick<WorkflowRun, "status" | "pausedAt"> | null
  homeNode: string | null
  nodeId: string
  hasForwarder: boolean
  hasTriggerNode: boolean
  trigger: TriggerFields
  event: ChannelTriggerEvent
}

/** The verdict, in the order `dispatchOneLegacy` checks it. */
export function channelClaim(s: ChannelClaimState): ChannelVerdict {
  if (s.activeRunId && s.homeNode && s.homeNode !== s.nodeId) return s.hasForwarder ? "forward" : "no-forwarder"
  if (!s.run) return s.hasTriggerNode ? "start" : "no-trigger"
  if (s.run.status === "paused" && s.run.pausedAt) {
    if (s.run.pausedAt.kind !== "checkpoint") return "paused-other"
    return matchesResume(s.run.pausedAt.resumeMatch, s.trigger, s.event) ? "resume" : "resume-mismatch"
  }
  if (s.run.status === "running") return "running"
  return "dead"
}

/** Verdicts by which a run that already exists takes the message. A run
 *  that would only start is no claim for the gate: a courtesy message after
 *  the end must not start one. */
export const GATE_CLAIMS: ReadonlySet<ChannelVerdict> = new Set(["forward", "resume", "running"])

/** The workflows `dispatch` tries: only the first match, unless one of
 *  them fans out. */
export function dispatchTargets<T extends { fanOut?: boolean }>(matches: T[]): T[] {
  const willFan = matches.some((m) => m.fanOut)
  return willFan ? matches : matches.slice(0, 1)
}

/** Whether the claim blocks the router's own reply: false when every
 *  claiming workflow's trigger is `passthrough: true`. */
export function blocksRouter(claimed: Pick<Workflow, "nodes">[]): boolean {
  if (claimed.length === 0) return false
  return !claimed.every((wf) => {
    const trigger = wf.nodes.find((n) => n.type.startsWith("trigger."))
    return (trigger?.config as { passthrough?: boolean } | undefined)?.passthrough === true
  })
}

export function channelToTriggerSource(channel: string): string | null {
  switch (channel) {
    case "telegram":    return "telegram-message"
    case "whatsapp":    return "whatsapp-message"
    case "discord":     return "discord-message"
    case "slack":       return "slack-message"
    default:            return null
  }
}

export function buildChannelTriggerPayload(msg: IncomingMessage): Record<string, unknown> {
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

/** The trigger, entity and event a channel message is dispatched with, or
 *  null for a channel no workflow can be triggered from. */
export function channelDispatchArgs(msg: IncomingMessage): { trigger: TriggerFields; entityRef: EntityRef; event: ChannelTriggerEvent } | null {
  const source = channelToTriggerSource(msg.channel)
  if (!source) return null
  const chatId = msg.group?.id ?? msg.sender.id
  return {
    trigger: { source, chat: chatId },
    entityRef: { backend: msg.channel, id: `${msg.channel}:${chatId}` },
    event: { id: `${msg.channel}:${msg.accountId}:${msg.id}`, payload: buildChannelTriggerPayload(msg) },
  }
}

/** An inbound message as a `person.wait` step sees it. */
export interface ReplyFields { channel: string; chatId: string; accountId?: string; senderId?: string }

/** Does this run, waiting for a reply, take this message? Same channel,
 *  same chat, same account when both name one, same sender when the wait
 *  names one. */
export function replyWaitMatches(p: Extract<PausedAt, { kind: "replyWait" }>, msg: ReplyFields): boolean {
  const source = `${msg.channel}-message`
  if (p.channel !== msg.channel) return false
  if (normalizeChat(source, p.chatId) !== normalizeChat(source, msg.chatId)) return false
  if (p.accountId && msg.accountId && p.accountId !== msg.accountId) return false
  if (p.from && normalizeChat(source, p.from) !== normalizeChat(source, msg.senderId ?? "")) return false
  return true
}

/** Does the incoming event's trigger fields match the checkpoint's
 *  resumeMatch filter? Empty/missing fields are wildcards (match anything),
 *  so the default `resumeMatch: {}` accepts any event on the entity. */
export function matchesResume(
  resumeMatch: Record<string, unknown>,
  trigger: { source?: string; project?: string; repo?: string; chat?: string; labels?: string[] },
  event: { id: string },
): boolean {
  const match = (k: keyof typeof trigger): boolean => {
    const want = resumeMatch[k]
    if (want === undefined || want === "" || want === "*") return true
    if (Array.isArray(want)) {
      const have = new Set(trigger.labels ?? [])
      return (want as string[]).some((l) => have.has(String(l)))
    }
    if (k === "chat") {
      return normalizeChat(trigger.source, String(want)) === normalizeChat(trigger.source, trigger.chat)
    }
    return trigger[k] === want
  }
  // Fields supported in v1: source, project, repo, chat, labels. Additional
  // keys in resumeMatch are ignored (won't accidentally block resume).
  if (!match("source")) return false
  if (!match("project")) return false
  if (!match("repo")) return false
  if (!match("chat")) return false
  // `eventIdLike`: optional substring match on the event id, useful for
  // resuming only on events that carry a specific marker.
  const eventIdLike = resumeMatch.eventIdLike
  if (typeof eventIdLike === "string" && eventIdLike && !event.id.includes(eventIdLike)) return false
  return true
}
