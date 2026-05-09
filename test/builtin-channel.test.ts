import { describe, it, expect, beforeEach, afterEach } from "vitest"
import {
  registerAllBuiltins,
  runBuiltin,
  _resetBuiltinsForTesting,
} from "../src/actions/builtin"
import {
  setMessageRouter,
  resetMessageRouterForTesting,
} from "../src/channels/router-instance"

interface SendCall {
  msg: { channel: string; chatId: string; text: string; agentId?: string; replyTo?: string }
  opts?: { idempotencyKey?: string; dedupeWindowMs?: number }
}

function makeFakeRouter(opts?: { nextMessageId?: string | null | undefined }): {
  router: any
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  const hasOverride = opts && Object.prototype.hasOwnProperty.call(opts, "nextMessageId")
  const router = {
    sendOutbound: async (msg: SendCall["msg"], sendOpts?: SendCall["opts"]) => {
      calls.push({ msg, opts: sendOpts })
      // Honor the test's explicit override (incl. null/undefined for "adapter
      // returned no id") so each test case can pin the simulated outcome.
      if (hasOverride) return opts!.nextMessageId
      return "msg-123"
    },
    getChannel: (name: string) => {
      if (name === "gitlab") {
        return {
          setLabels: async ({ project, kind, iid, add, remove }: any) => {
            return [`<echo:${project}:${kind}:${iid}:+${(add ?? []).join("+")}:-${(remove ?? []).join("+")}>`]
          },
          setAssignees: async ({ project, kind, iid, assignees }: any) => {
            // Echo each assignee as id 1000+index so callers can verify ordering.
            return assignees.map((_: string, i: number) => 1000 + i)
          },
          createIssue: async ({ project, title }: any) => {
            return { iid: 9001, url: `https://example.invalid/${project}/-/issues/9001#${title}` }
          },
          relateIssue: async (_args: any) => {
            return true
          },
        }
      }
      return undefined
    },
  }
  return { router, calls }
}

beforeEach(() => {
  _resetBuiltinsForTesting()
  registerAllBuiltins()
  resetMessageRouterForTesting()
})

afterEach(() => {
  resetMessageRouterForTesting()
})

describe("channel.reply", () => {
  it("rejects when message router is not wired", async () => {
    await expect(runBuiltin("channel.reply", {
      channel: "gitlab",
      chatId: "org/repo:issue:1",
      text: "hi",
    })).rejects.toThrow(/message router not wired/)
  })

  it("forwards through router.sendOutbound with idempotency by default", async () => {
    const { router, calls } = makeFakeRouter()
    setMessageRouter(router as any)

    const out: any = await runBuiltin("channel.reply", {
      channel: "gitlab",
      chatId: "mtgl/mtgl-system-v2:merge_request:236",
      text: "First answer.",
      agentId: "mtgl-v2",
    })

    expect(out.messageId).toBe("msg-123")
    expect(calls).toHaveLength(1)
    expect(calls[0].msg.channel).toBe("gitlab")
    expect(calls[0].msg.chatId).toBe("mtgl/mtgl-system-v2:merge_request:236")
    expect(calls[0].msg.text).toBe("First answer.")
    expect(calls[0].msg.agentId).toBe("mtgl-v2")
    // Idempotency is opt-IN. Action MUST pass an idempotencyKey for the
    // router-level dedupe to engage. Empty string = router uses body hash.
    expect(calls[0].opts?.idempotencyKey).toBe("")
    expect(calls[0].opts?.dedupeWindowMs).toBe(60_000)
  })

  it("passes through caller-provided explicit idempotencyKey", async () => {
    const { router, calls } = makeFakeRouter()
    setMessageRouter(router as any)

    await runBuiltin("channel.reply", {
      channel: "gitlab",
      chatId: "org/repo:issue:1",
      text: "Body changed but same intent.",
      idempotencyKey: "status-update-v1",
    })

    expect(calls[0].opts?.idempotencyKey).toBe("status-update-v1")
  })

  it("returns null messageId when adapter returns void", async () => {
    const { router } = makeFakeRouter({ nextMessageId: undefined })
    setMessageRouter(router as any)
    const out: any = await runBuiltin("channel.reply", {
      channel: "telegram",
      chatId: "12345",
      text: "no id",
    })
    // Action coerces non-string returns to null per its output contract.
    expect(out.messageId).toBeNull()
  })
})

describe("channel.label", () => {
  it("forwards add/remove to the channel's setLabels", async () => {
    const { router } = makeFakeRouter()
    setMessageRouter(router as any)
    const out: any = await runBuiltin("channel.label", {
      channel: "gitlab",
      project: "mtgl/mtgl-system-v2",
      kind: "merge_request",
      iid: "236",
      add: ["Doing"],
      remove: ["Triage", "To Do"],
      agentId: "mtgl-v2",
    })
    expect(out.labels).toEqual([
      "<echo:mtgl/mtgl-system-v2:merge_request:236:+Doing:-Triage+To Do>",
    ])
  })

  it("rejects channels that don't expose setLabels", async () => {
    const router = {
      sendOutbound: async () => null,
      getChannel: (_name: string) => undefined,
    }
    setMessageRouter(router as any)
    await expect(runBuiltin("channel.label", {
      channel: "gitlab",
      project: "x/y",
      kind: "issue",
      iid: "1",
    })).rejects.toThrow(/does not expose setLabels/)
  })
})

describe("channel.assign", () => {
  it("forwards assignee usernames to setAssignees and returns resolved ids", async () => {
    const { router } = makeFakeRouter()
    setMessageRouter(router as any)
    const out: any = await runBuiltin("channel.assign", {
      channel: "gitlab",
      project: "mtgl/mtgl-system-v2",
      kind: "issue",
      iid: "236",
      assignees: ["coding-mtgl-v2", "noqta-pm-mtgl"],
      agentId: "pm-mtgl",
    })
    expect(out.assigneeIds).toEqual([1000, 1001])
  })

  it("accepts an empty assignees array (unassign)", async () => {
    const { router } = makeFakeRouter()
    setMessageRouter(router as any)
    const out: any = await runBuiltin("channel.assign", {
      channel: "gitlab",
      project: "x/y",
      kind: "merge_request",
      iid: "1",
      assignees: [],
    })
    expect(out.assigneeIds).toEqual([])
  })
})

describe("channel.create_issue", () => {
  it("creates an issue and returns iid + url", async () => {
    const { router } = makeFakeRouter()
    setMessageRouter(router as any)
    const out: any = await runBuiltin("channel.create_issue", {
      channel: "gitlab",
      project: "mtgl/mtgl-system-v2",
      title: "Test case for #236",
      description: "Reproduce: …",
      labels: ["test", "QA"],
      assignees: ["qa-forensics"],
      agentId: "pm-mtgl",
    })
    expect(out.iid).toBe(9001)
    expect(out.url).toContain("9001")
    expect(out.related).toBe(false)
  })

  it("relates to a parent issue when relateToIid is set", async () => {
    const { router } = makeFakeRouter()
    setMessageRouter(router as any)
    const out: any = await runBuiltin("channel.create_issue", {
      channel: "gitlab",
      project: "mtgl/mtgl-system-v2",
      title: "Test case for #236",
      relateToIid: "236",
    })
    expect(out.related).toBe(true)
  })
})
