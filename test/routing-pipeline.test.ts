import { describe, it, expect } from "vitest"
import { fromIncoming } from "../src/channels/inbound/envelope"
import { runPipeline } from "../src/channels/inbound/pipeline"
import { defaultPipeline } from "../src/channels/inbound/stages"
import type { IncomingMessage } from "../src/channels/types"
import type { DaemonConfig } from "../src/daemon/config"
import { HandoverStore } from "../src/channels/handover-store"

// Stub a registry that resolves mentions deterministically. Mirrors the
// shape of AgentRegistry.findByMention enough for routing tests.
class StubRegistry {
  constructor(private mentionMap: Record<string, string>) {}
  findByMention(text: string, opts?: { atMentionsOnly?: boolean }): string | undefined {
    for (const [handle, agentId] of Object.entries(this.mentionMap)) {
      const atForm = `@${handle}`
      if (text.includes(atForm)) return agentId
      if (!opts?.atMentionsOnly) {
        if (new RegExp(`\\b${handle}\\b`, "i").test(text)) return agentId
      }
    }
    return undefined
  }
}

const baseConfig: any = {
  channels: {
    telegram: {
      accounts: {
        coder: { token: "x", agentBinding: "coder-agent" },
        devops: { token: "y", agentBinding: "devops-agent" },
      },
      policy: { group: "mention-required", dm: "pair", allowFrom: undefined },
    },
    whatsapp: {
      defaultAgent: "cx-agent",
    },
  },
}

function makeIncoming(overrides: Partial<IncomingMessage> & {
  channel: string
  accountId: string
  sender?: any
  text?: string
}): IncomingMessage {
  return {
    id: overrides.id ?? "msg-1",
    channel: overrides.channel,
    accountId: overrides.accountId,
    sender: overrides.sender ?? { id: "u-1", name: "alice", isBot: false },
    text: overrides.text ?? "",
    group: overrides.group,
    resolvedAgent: overrides.resolvedAgent,
    replyTo: overrides.replyTo,
    replyToText: overrides.replyToText,
  } as IncomingMessage
}

function run(msg: IncomingMessage, opts: {
  registry?: StubRegistry
  config?: any
  handover?: HandoverStore
} = {}) {
  const config = opts.config ?? baseConfig
  const registry = opts.registry ?? new StubRegistry({})
  const handoverStore = opts.handover ?? new HandoverStore()
  return runPipeline(fromIncoming(msg), defaultPipeline, {
    config: config as DaemonConfig,
    registry: registry as any,
    handoverStore,
  })
}

describe("routing pipeline — invariants", () => {
  it("DM routes to the account's agentBinding (telegram)", () => {
    const r = run(makeIncoming({ channel: "telegram", accountId: "coder" }))
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("coder-agent")
    expect(r.decidingStage).toBe("dm-binding")
  })

  it("DM routes to defaultAgent (whatsapp)", () => {
    const r = run(makeIncoming({ channel: "whatsapp", accountId: "default" }))
    expect(r.agentId).toBe("cx-agent")
    expect(r.decidingStage).toBe("dm-binding")
  })

  it("group + mention-required + no @-mention = drop", () => {
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        text: "hey team",
        group: { id: "-100123", name: "Dev" },
      }),
      { registry: new StubRegistry({ "noqta_devops_bot": "devops-agent" }) },
    )
    expect(r.kind).toBe("drop")
    expect(r.decidingStage).toBe("mention")
    expect(r.reason).toContain("mention-required")
  })

  it("group + mention-required + @-mention matches", () => {
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        text: "@noqta_devops_bot please ssh in",
        group: { id: "-100123", name: "Dev" },
      }),
      { registry: new StubRegistry({ "noqta_devops_bot": "devops-agent" }) },
    )
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("devops-agent")
    expect(r.decidingStage).toBe("mention")
  })

  it("bot-origin in group: only @-mention counts (bare word ignored)", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig))
    cfg.channels.telegram.policy.group = "all" // disable mention-required
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        text: "nadia is on it",
        group: { id: "-100123" },
        sender: { id: "bot-1", isBot: true, name: "DevOps Bot" },
      }),
      {
        config: cfg,
        registry: new StubRegistry({ noqta_nadia_bot: "marketing-agent", nadia: "marketing-agent" }),
      },
    )
    expect(r.kind).toBe("drop")
    expect(r.reason).toContain("bot-origin")
  })

  it("bot-origin in group + explicit @-mention is honored", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig))
    cfg.channels.telegram.policy.group = "all"
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        text: "@noqta_nadia_bot can you help?",
        group: { id: "-100123" },
        sender: { id: "bot-1", isBot: true },
      }),
      {
        config: cfg,
        registry: new StubRegistry({ noqta_nadia_bot: "marketing-agent", nadia: "marketing-agent" }),
      },
    )
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("marketing-agent")
  })

  it("self-reply (agentx marker in body) drops", () => {
    const r = run(
      makeIncoming({
        channel: "gitlab",
        accountId: "default",
        text: "Done with the fix.\n\n<!-- agentx:coder-agent -->",
      }),
    )
    expect(r.kind).toBe("drop")
    expect(r.decidingStage).toBe("self-reply-guard")
    expect(r.reason).toContain("agentx-marker")
  })

  it("handover override beats every other rule", () => {
    const handover = new HandoverStore({ baseDir: "/tmp/handover-test-" + Date.now() })
    handover.set({
      channel: "telegram",
      chatId: "u-1",
      accountId: "coder",
      fromAgent: "coder-agent",
      toAgent: "devops-agent",
      createdAt: new Date().toISOString(),
    })
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        sender: { id: "u-1", isBot: false },
        text: "hello",
      }),
      { handover },
    )
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("devops-agent")
    expect(r.decidingStage).toBe("handover")
  })

  it("gitlab without resolvedAgent drops at adapter-resolved stage", () => {
    const r = run(
      makeIncoming({
        channel: "gitlab",
        accountId: "default",
        text: "@some-random-username please review",
      }),
    )
    expect(r.kind).toBe("drop")
    expect(r.decidingStage).toBe("adapter-resolved")
    expect(r.reason).toContain("no agent mapping")
  })

  it("gitlab with resolvedAgent matches at adapter-resolved", () => {
    const r = run(
      makeIncoming({
        channel: "gitlab",
        accountId: "default",
        text: "@coding-ksi please look at this",
        resolvedAgent: "coding-ksi",
      }),
    )
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("coding-ksi")
    expect(r.decidingStage).toBe("adapter-resolved")
  })

  it("group + policy=all + bare-word match (human sender) routes via mention", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig))
    cfg.channels.telegram.policy.group = "all"
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        text: "nadia please draft a tweet",
        group: { id: "-100123" },
        sender: { id: "u-1", isBot: false },
      }),
      {
        config: cfg,
        registry: new StubRegistry({ noqta_nadia_bot: "marketing-agent", nadia: "marketing-agent" }),
      },
    )
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("marketing-agent")
    expect(r.decidingStage).toBe("mention")
  })

  it("group + policy=all + no mention falls back to account binding", () => {
    const cfg = JSON.parse(JSON.stringify(baseConfig))
    cfg.channels.telegram.policy.group = "all"
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
        text: "anyone there?",
        group: { id: "-100123" },
        sender: { id: "u-1", isBot: false },
      }),
      { config: cfg },
    )
    expect(r.kind).toBe("match")
    expect(r.agentId).toBe("coder-agent")
    expect(r.decidingStage).toBe("fallback-binding")
  })

  it("trace includes every stage that ran, in order", () => {
    const r = run(
      makeIncoming({
        channel: "telegram",
        accountId: "coder",
      }),
    )
    const stages = r.trace.map(t => t.stage)
    // self-reply, handover, adapter-resolved, then dm-binding matches.
    expect(stages.slice(0, 4)).toEqual(["self-reply-guard", "handover", "adapter-resolved", "dm-binding"])
  })
})
