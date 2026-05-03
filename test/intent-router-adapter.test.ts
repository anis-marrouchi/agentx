import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { IntentLedger } from "../src/intent/ledger"
import {
  buildRouterEventInput,
  buildRouterPolicyFromLegacy,
  recordRouterDispatch,
  routerChannelToSource,
  type RouterMessageProjection,
} from "../src/intent/sources/router"

// Tests for Phase 1 commit 6.b — channel-router adapter helpers.

let tmp: string
let ledger: IntentLedger

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-router-adapter-"))
  ledger = new IntentLedger({ path: path.join(tmp, "ledger.sqlite") })
})

afterEach(() => {
  ledger.close()
  rmSync(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const dmMessage: RouterMessageProjection = {
  id: "msg-1",
  channel: "telegram",
  accountId: "default",
  sender: { id: "user-42" },
}

const groupMessage: RouterMessageProjection = {
  id: "msg-2",
  channel: "telegram",
  accountId: "agent-bot",
  sender: { id: "user-7" },
  group: { id: "-1003861455814" },
}

describe("buildRouterEventInput", () => {
  it("DM: subject scopes by sender id; sourceEventId combines accountId/msgId", () => {
    const input = buildRouterEventInput(dmMessage, "telegram", "{}", () => 999)
    expect(input).toEqual({
      ts: 999,
      source: "telegram",
      sourceEventId: "default/msg-1",
      project: null,
      subject: "chat:user-42",
      intent: "message.received",
      rawJson: "{}",
    })
  })

  it("group: subject scopes by group id (matches the legacy chatId derivation)", () => {
    const input = buildRouterEventInput(groupMessage, "telegram", "{}", () => 1)
    expect(input.subject).toBe("chat:-1003861455814")
    expect(input.sourceEventId).toBe("agent-bot/msg-2")
  })

  it("missing accountId falls back to 'default' so re-deliveries via different accounts dedupe correctly", () => {
    const noAccount: RouterMessageProjection = { ...dmMessage, accountId: undefined }
    const input = buildRouterEventInput(noAccount, "telegram", "{}", () => 1)
    expect(input.sourceEventId).toBe("default/msg-1")
  })

  it("intent flips to message.reply when replyTo is present", () => {
    const reply: RouterMessageProjection = { ...dmMessage, replyTo: "msg-prev" }
    expect(buildRouterEventInput(reply, "telegram", "{}", () => 1).intent).toBe("message.reply")
  })

  it("project axis is null — router has no project axis", () => {
    expect(buildRouterEventInput(dmMessage, "telegram", "{}", () => 1).project).toBeNull()
  })
})

describe("buildRouterPolicyFromLegacy", () => {
  it("decidedBy is the stable string 'channel-router' so chains are readable", () => {
    expect(buildRouterPolicyFromLegacy({ outcome: "dispatched", agentId: "x" }).decidedBy)
      .toBe("channel-router")
  })

  it("dispatched legacy → policy returns dispatched/agentId verbatim", () => {
    const policy = buildRouterPolicyFromLegacy({
      outcome: "dispatched", agentId: "mtgl-v2", reason: "mention-stage",
    })
    expect(policy.decide({} as any)).toEqual({
      agentId: "mtgl-v2", outcome: "dispatched", reason: "mention-stage",
    })
  })

  it("halted legacy → policy returns halted with the legacy reason", () => {
    const policy = buildRouterPolicyFromLegacy({
      outcome: "halted", agentId: null, reason: "no-match",
    })
    expect(policy.decide({} as any)).toEqual({
      agentId: null, outcome: "halted", reason: "no-match",
    })
  })

  it("deduped legacy → policy maps to halted with reason prefixed 'legacy-dedup' (PolicyDecision can't say 'deduped')", () => {
    const policy = buildRouterPolicyFromLegacy({
      outcome: "deduped", agentId: null, reason: "isDuplicateMessage",
    })
    const decided = policy.decide({} as any)
    expect(decided.outcome).toBe("halted")
    expect(decided.reason).toBe("legacy-dedup: isDuplicateMessage")
  })

  it("queued legacy passes through unchanged", () => {
    const policy = buildRouterPolicyFromLegacy({
      outcome: "queued", agentId: "x", reason: "rate-limited",
    })
    expect(policy.decide({} as any).outcome).toBe("queued")
  })
})

describe("recordRouterDispatch", () => {
  it("agreement (dispatched/X = dispatched/X): event+decision recorded, no divergence row", () => {
    recordRouterDispatch(
      ledger, dmMessage, "telegram", "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention" },
      () => 1,
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(1)
    expect(ledger.getDivergences()).toHaveLength(0)
  })

  it("legacy 'deduped' produces a divergence row — policy can't say deduped, so ledger=halted vs legacy=deduped", () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    recordRouterDispatch(
      ledger, dmMessage, "telegram", "{}",
      { agentId: null, outcome: "deduped", reason: "isDuplicateMessage" },
      () => 1,
    )
    const divergences = ledger.getDivergences()
    expect(divergences).toHaveLength(1)
    expect(divergences[0].ledgerOutcome).toBe("halted") // policy mapped from legacy "deduped"
    expect(divergences[0].legacyOutcome).toBe("deduped") // raw legacy preserved
    expect(divergences[0].legacyReason).toBe("isDuplicateMessage")
  })

  it("re-delivery is idempotent at the per-policy layer (one event, one decision regardless of repeat calls)", () => {
    for (let i = 0; i < 5; i++) {
      recordRouterDispatch(
        ledger, dmMessage, "telegram", "{}",
        { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention" },
        () => 1 + i,
      )
    }
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(1)
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_decisions").get() as { n: number }).n,
    ).toBe(1)
  })

  it("two messages on the same chat dispatch independently (project=null disables active-task safety)", () => {
    // The router has no project axis, so Inv-ActiveTaskSafety
    // (`getActiveDecisionForSubject` short-circuits on null project)
    // does not engage. Two messages in the same chat both dispatch on
    // their own merits — exactly matching legacy semantics. The soak
    // therefore sees zero divergences for this trivial case; mismatches
    // would only surface from the LRU dedup vs ledger idempotency
    // axis, which this test doesn't exercise.
    recordRouterDispatch(
      ledger,
      { ...groupMessage, id: "msg-A" }, "telegram", "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention" },
      () => 1,
    )
    recordRouterDispatch(
      ledger,
      { ...groupMessage, id: "msg-B" }, "telegram", "{}",
      { agentId: "mtgl-v2", outcome: "dispatched", reason: "mention" },
      () => 2,
    )
    expect(
      (ledger.db.prepare("SELECT COUNT(*) as n FROM intent_events").get() as { n: number }).n,
    ).toBe(2)
    expect(ledger.getDivergences()).toHaveLength(0)
  })
})

describe("routerChannelToSource", () => {
  it("maps the four router-supported channels to themselves", () => {
    expect(routerChannelToSource("telegram")).toBe("telegram")
    expect(routerChannelToSource("slack")).toBe("slack")
    expect(routerChannelToSource("whatsapp")).toBe("whatsapp")
    expect(routerChannelToSource("discord")).toBe("discord")
  })

  it("returns null for unsupported channels (gitlab routes itself, etc.)", () => {
    expect(routerChannelToSource("gitlab")).toBeNull()
    expect(routerChannelToSource("github")).toBeNull()
    expect(routerChannelToSource("workflow")).toBeNull()
    expect(routerChannelToSource("unknown")).toBeNull()
    expect(routerChannelToSource("")).toBeNull()
  })
})

describe("recordRouterDispatch — multi-channel coverage", () => {
  it("slack: source flows through to event + divergence rows", () => {
    const slackMsg: RouterMessageProjection = {
      id: "slack-msg-1",
      channel: "slack",
      accountId: "team-a",
      sender: { id: "U01" },
    }
    recordRouterDispatch(
      ledger, slackMsg, "slack", "{}",
      { agentId: "agent-x", outcome: "dispatched", reason: "mention" },
      () => 1,
    )
    const event = ledger.db.prepare("SELECT * FROM intent_events").get() as any
    expect(event.source).toBe("slack")
    expect(event.source_event_id).toBe("team-a/slack-msg-1")
  })

  it("whatsapp: source flows through", () => {
    const waMsg: RouterMessageProjection = {
      id: "wa-msg-1",
      channel: "whatsapp",
      sender: { id: "21621624309128@s.whatsapp.net" },
    }
    recordRouterDispatch(
      ledger, waMsg, "whatsapp", "{}",
      { agentId: "atlas", outcome: "dispatched" },
      () => 1,
    )
    const event = ledger.db.prepare("SELECT * FROM intent_events").get() as any
    expect(event.source).toBe("whatsapp")
  })

  it("discord: source flows through", () => {
    const dcMsg: RouterMessageProjection = {
      id: "dc-msg-1",
      channel: "discord",
      sender: { id: "user-1" },
    }
    recordRouterDispatch(
      ledger, dcMsg, "discord", "{}",
      { agentId: "agent-y", outcome: "dispatched" },
      () => 1,
    )
    const event = ledger.db.prepare("SELECT * FROM intent_events").get() as any
    expect(event.source).toBe("discord")
  })
})
