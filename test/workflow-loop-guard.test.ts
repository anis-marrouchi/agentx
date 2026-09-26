import { describe, it, expect, vi } from "vitest"
import { startWorkflowTriggers } from "../src/workflows/triggers"
import { checkLoopGuard, eventAuthor, eventTargetKey, FireWindow } from "../src/workflows/loop-guard"

type Handler = (ctx: Record<string, unknown>) => Promise<{ modified?: Record<string, unknown> }>

function wf(id: string, agentId: string, event: string, filter?: Record<string, unknown>) {
  return {
    id,
    version: 2,
    title: id,
    state: "active",
    nodes: [
      { id: "t", type: "trigger.hook", config: { event, ...(filter ? { filter } : {}) } },
      { id: "a", type: "agent", config: { agentId, prompt: "go" } },
    ],
    edges: [{ from: "t", to: "a" }],
  }
}

/** Boot the real trigger registrar against fakes. `fire` runs every
 *  subscriber of an event in registration order, like HookRegistry. */
function boot(workflows: any[], forgeUsernames?: (a: string) => string[]) {
  const handlers = new Map<string, Array<{ name: string; fn: Handler }>>()
  const hooks = {
    registerHandler: (event: string, name: string, fn: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), { name, fn }])
    },
  }
  const dispatched: string[] = []
  const dispatcher = {
    dispatchWorkflow: vi.fn(async (a: { workflowId: string }) => { dispatched.push(a.workflowId); return {} }),
  }
  const logs: string[] = []
  startWorkflowTriggers({
    store: { list: () => workflows } as any,
    dispatcher: dispatcher as any,
    hooks: hooks as any,
    log: (m) => logs.push(m),
    forgeUsernames,
  })
  const fire = async (event: string, ctx: Record<string, unknown>) => {
    const claimed: string[] = []
    for (const h of handlers.get(event) ?? []) {
      const r = await h.fn({ event, ...ctx })
      const c = r.modified?.__workflowClaimed
      if (Array.isArray(c)) claimed.splice(0, claimed.length, ...c)
    }
    return claimed
  }
  return { fire, dispatched, logs }
}

describe("workflow loop guard — self-authored events", () => {
  it("skips an MR event authored by the workflow's own agent (adapter-stamped authorAgent)", async () => {
    const { fire, dispatched, logs } = boot([wf("mr-review", "review-agent", "on:gitlab-mr", { skipSelfAuthored: true })])
    await fire("on:gitlab-mr", { project: "acme/app", iid: 5, author: "review-bot", authorAgent: "review-agent" })
    expect(dispatched).toEqual([])
    expect(logs.some((l) => l.includes("mr-review skipping on:gitlab-mr (self-authored)"))).toBe(true)

    await fire("on:gitlab-mr", { project: "acme/app", iid: 5, author: "human-dev", authorAgent: null })
    expect(dispatched).toEqual(["mr-review"])
  })

  it("resolves own identity from configured forge usernames (GitHub)", async () => {
    const { fire, dispatched } = boot(
      [wf("pr-review", "review-agent", "on:github-pr", { skipSelfAuthored: true })],
      (a) => (a === "review-agent" ? ["Review-Bot"] : []),
    )
    await fire("on:github-pr", { payload: { sender: { login: "review-bot" }, repository: { full_name: "acme/app" }, pull_request: { number: 9 } } })
    expect(dispatched).toEqual([])
    await fire("on:github-pr", { author: "human-dev", repo: "acme/app", number: 9 })
    expect(dispatched).toEqual(["pr-review"])
  })

  it("is off by default, so lifecycle loops still see their own transitions", async () => {
    const { fire, dispatched } = boot([wf("sdlc", "coder", "on:gitlab-issue")])
    await fire("on:gitlab-issue", { project: "acme/app", iid: 1, author: "coder-bot", authorAgent: "coder" })
    expect(dispatched).toEqual(["sdlc"])
  })

  it("logs once when no identity is known, and still fires", async () => {
    const { fire, dispatched, logs } = boot([wf("gh", "coder", "on:github-issue", { skipSelfAuthored: true })])
    await fire("on:github-issue", { author: "someone", repo: "acme/app", number: 1 })
    await fire("on:github-issue", { author: "someone", repo: "acme/app", number: 2 })
    expect(dispatched).toEqual(["gh", "gh"])
    expect(logs.filter((l) => l.includes("self-authored skip inactive")).length).toBe(1)
  })
})

describe("workflow loop guard — filter.ignoreAuthors", () => {
  it("skips listed authors case-insensitively, with or without @", async () => {
    const { fire, dispatched, logs } = boot([wf("notes", "coder", "on:gitlab-note", { ignoreAuthors: ["@CI-Bot"] })])
    await fire("on:gitlab-note", { project: "acme/app", noteableType: "merge_request", noteableIid: "3", authorUsername: "ci-bot" })
    expect(dispatched).toEqual([])
    expect(logs.some((l) => l.includes("(ignored-author)"))).toBe(true)
    await fire("on:gitlab-note", { project: "acme/app", noteableType: "merge_request", noteableIid: "3", authorUsername: "human-dev" })
    expect(dispatched).toEqual(["notes"])
  })
})

describe("workflow loop guard — two-routine ping-pong", () => {
  it("caps each routine per target via filter.maxFiresPerTarget", async () => {
    // Generator and critic wake each other on notes of the same MR. Each is
    // authored by the *other* routine's bot, so the self skip can't help.
    const limit = { maxFiresPerTarget: { count: 2, windowMinutes: 30 } }
    const { fire, dispatched, logs } = boot([
      wf("generator", "coder", "on:gitlab-note", limit),
      wf("critic", "reviewer", "on:gitlab-note", limit),
    ])
    const note = (author: string, authorAgent: string, iid = "7") =>
      fire("on:gitlab-note", { project: "acme/app", noteableType: "merge_request", noteableIid: iid, author, authorAgent })

    // Ping-pong: critic's note wakes generator, generator's note wakes critic.
    for (let i = 0; i < 5; i++) {
      await note("reviewer-bot", "reviewer")
      await note("coder-bot", "coder")
    }
    expect(dispatched.filter((w) => w === "generator").length).toBe(2)
    expect(dispatched.filter((w) => w === "critic").length).toBe(2)
    expect(logs.some((l) => l.includes("(chain-limit)") && l.includes("gitlab:acme/app!7"))).toBe(true)

    // A different MR has its own budget.
    await note("reviewer-bot", "reviewer", "8")
    expect(dispatched.filter((w) => w === "generator").length).toBe(3)
  })

  it("chain-limit skip still claims the event so legacy dispatch stays quiet", async () => {
    const { fire } = boot([wf("gen", "coder", "on:gitlab-mr", { maxFiresPerTarget: { count: 1, windowMinutes: 5 } })])
    expect(await fire("on:gitlab-mr", { project: "acme/app", iid: 2, author: "human-dev" })).toEqual(["gen"])
    expect(await fire("on:gitlab-mr", { project: "acme/app", iid: 2, author: "human-dev" })).toEqual(["gen"])
  })
})

describe("loop-guard helpers", () => {
  it("keys notes and MR events on the same target", () => {
    expect(eventTargetKey("on:gitlab-mr", { project: "a/b", iid: 4 })).toBe("gitlab:a/b!4")
    expect(eventTargetKey("on:gitlab-note", { project: "a/b", noteableType: "merge_request", noteableIid: "4" })).toBe("gitlab:a/b!4")
    expect(eventTargetKey("on:gitlab-note", { project: "a/b", noteableType: "issue", noteableIid: "4" })).toBe("gitlab:a/b#4")
    expect(eventTargetKey("on:github-pr", { payload: { repository: { full_name: "a/b" }, pull_request: { number: 4 } } })).toBe("github:a/b#4")
    expect(eventTargetKey("on:gitlab-pipeline", { project: "a/b" })).toBeUndefined()
  })

  it("reads the author from author, authorUsername, or GitHub sender", () => {
    expect(eventAuthor({ author: "@Bot" })).toBe("bot")
    expect(eventAuthor({ authorUsername: "bot" })).toBe("bot")
    expect(eventAuthor({ payload: { sender: { login: "bot" } } })).toBe("bot")
    expect(eventAuthor({})).toBeUndefined()
  })

  it("fire window slides and stays bounded", () => {
    const w = new FireWindow(2)
    expect(w.tryFire("k", 1, 1000, 0)).toBe(true)
    expect(w.tryFire("k", 1, 1000, 500)).toBe(false)
    expect(w.tryFire("k", 1, 1000, 1001)).toBe(true)
    w.tryFire("k2", 1, 1000, 0)
    w.tryFire("k3", 1, 1000, 0)
    expect(w.size).toBe(2)
  })

  it("doesn't advance the counter when the event is skipped for authorship", () => {
    const fireWindow = new FireWindow()
    const deps = { fireWindow, log: () => {} }
    const w = { id: "x", nodes: [{ id: "a", type: "agent", config: { agentId: "coder" } }] } as any
    const filter = { skipSelfAuthored: true, maxFiresPerTarget: { count: 1, windowMinutes: 5 } }
    const ctx = { project: "a/b", iid: 1, author: "coder-bot", authorAgent: "coder" }
    expect(checkLoopGuard(w, "on:gitlab-mr", ctx, filter, deps)).toMatchObject({ skip: true, reason: "self-authored" })
    expect(fireWindow.size).toBe(0)
  })
})
