import { describe, expect, it } from "vitest"
import {
  GATE_CLAIMS, blocksRouter, channelClaim, channelDispatchArgs, dispatchTargets, replyWaitMatches,
  type ChannelClaimState,
} from "../src/workflows/channel-claim"
import type { IncomingMessage } from "../src/channels/types"

// #1892, R1: the dispatcher's channel-claim rule, taken out of
// dispatchOneLegacy into one pure function that the dispatcher and the
// courtesy gate both call. One row per verdict, in dispatchOneLegacy's order.

const base: ChannelClaimState = {
  activeRunId: null, run: null, homeNode: null, nodeId: "node-a",
  hasForwarder: true, hasTriggerNode: true,
  trigger: { source: "whatsapp-message", chat: "grp" },
  event: { id: "whatsapp:default:m1", payload: {} },
}
const paused = (pausedAt: unknown) => ({ status: "paused", pausedAt } as never)

describe("channelClaim", () => {
  it.each<[string, Partial<ChannelClaimState>, string]>([
    ["active run homed on a peer, forwarder present", { activeRunId: "r1", homeNode: "node-b" }, "forward"],
    ["active run homed on a peer, no forwarder", { activeRunId: "r1", homeNode: "node-b", hasForwarder: false }, "no-forwarder"],
    ["no active run", {}, "start"],
    ["an index pointing at a run that is gone", { activeRunId: "gone", homeNode: "node-a", run: null }, "start"],
    ["no active run, no trigger node", { hasTriggerNode: false }, "no-trigger"],
    ["paused, not on a checkpoint", { activeRunId: "r1", homeNode: "node-a", run: paused({ kind: "replyWait" }) }, "paused-other"],
    ["checkpoint, resumeMatch no", { activeRunId: "r1", homeNode: "node-a", run: paused({ kind: "checkpoint", resumeMatch: { chat: "other" } }) }, "resume-mismatch"],
    ["checkpoint, resumeMatch yes", { activeRunId: "r1", homeNode: "node-a", run: paused({ kind: "checkpoint", resumeMatch: {} }) }, "resume"],
    ["running", { activeRunId: "r1", homeNode: "node-a", run: { status: "running", pausedAt: null } as never }, "running"],
    ["completed", { activeRunId: "r1", homeNode: "node-a", run: { status: "completed", pausedAt: null } as never }, "dead"],
    ["paused without pausedAt", { activeRunId: "r1", homeNode: "node-a", run: { status: "paused", pausedAt: null } as never }, "dead"],
  ])("%s → %s", (_name, over, want) => {
    expect(channelClaim({ ...base, ...over })).toBe(want)
  })

  it("the gate counts only an existing run as a claim, never a start", () => {
    expect([...GATE_CLAIMS].sort()).toEqual(["forward", "resume", "running"])
  })
})

describe("dispatchTargets", () => {
  it("only the first match, unless one fans out", () => {
    expect(dispatchTargets([{ id: "a" }, { id: "b" }])).toEqual([{ id: "a" }])
    expect(dispatchTargets([{ id: "a" }, { id: "b", fanOut: true }])).toHaveLength(2)
  })
})

describe("blocksRouter", () => {
  const wf = (passthrough?: boolean) => ({ nodes: [{ id: "t", type: "trigger.channel", config: passthrough ? { passthrough } : {} }] }) as never
  it("a claim by passthrough-only workflows does not block the router", () => {
    expect(blocksRouter([wf(true)])).toBe(false)
    expect(blocksRouter([wf(true), wf(false)])).toBe(true)
    expect(blocksRouter([])).toBe(false)
  })
})

describe("replyWaitMatches", () => {
  const p = { kind: "replyWait", nodeId: "w", channel: "whatsapp", chatId: "120363000000000000@g.us", from: "+1 555 0100", accountId: "default" } as never
  it("same chat in any WhatsApp form; the sender must be the one waited for", () => {
    expect(replyWaitMatches(p, { channel: "whatsapp", chatId: "120363000000000000", senderId: "15550100@s.whatsapp.net" })).toBe(true)
    expect(replyWaitMatches(p, { channel: "whatsapp", chatId: "120363000000000000@g.us", senderId: "15550199@s.whatsapp.net" })).toBe(false)
    expect(replyWaitMatches(p, { channel: "whatsapp", chatId: "120363000000000000@g.us", senderId: "15550100", accountId: "other" })).toBe(false)
  })
})

describe("channelDispatchArgs", () => {
  it("builds the hook's trigger, entity and event id; null for a channel no workflow can be triggered from", () => {
    const msg = { id: "m1", channel: "whatsapp", accountId: "default", sender: { id: "u1", name: "U" }, group: { id: "grp", name: "G" }, text: "hi", timestamp: new Date(0) } as IncomingMessage
    const a = channelDispatchArgs(msg)!
    expect(a.trigger).toEqual({ source: "whatsapp-message", chat: "grp" })
    expect(a.entityRef).toEqual({ backend: "whatsapp", id: "whatsapp:grp" })
    expect(a.event.id).toBe("whatsapp:default:m1")
    expect(channelDispatchArgs({ ...msg, channel: "gitlab" })).toBeNull()
  })
})
