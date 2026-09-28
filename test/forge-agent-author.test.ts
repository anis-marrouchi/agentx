import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { GitHubAdapter } from "../src/channels/github"
import { GitLabAdapter } from "../src/channels/gitlab"
import {
  agentAuthorOf,
  agentHeader,
  detectAgentxMarker,
  forgeSender,
  markBody,
  ownEchoOf,
} from "../src/channels/outbound-marker"
import { classifyInitiator } from "../src/a2a/initiator"
import { recordsFromEntries } from "../src/wiki/facts/sources/entries"
import { MessageRouter } from "../src/channels/router"
import type { IncomingMessage } from "../src/channels/types"

// #282: where agents have no forge account of their own, an agent's comment
// is posted with the owner's token and arrives as the owner's comment. The
// #277 initiator check then read another agent's review as the owner starting
// work. The post carries the adapter's marker and/or its "(via AgentX)"
// header; either one makes the inbound sender `agent:<id>`.

const OWNER = "sam-owner"
const REPO = "acme/widgets"

const agentComment = (agent: string, text: string) => markBody(`${agentHeader(agent)}${text}`, agent)

describe("agentAuthorOf / forgeSender", () => {
  it("reads the marker, then the header", () => {
    expect(agentAuthorOf(agentComment("reviewer-agent", "Verdict: ready"))).toBe("reviewer-agent")
    expect(agentAuthorOf(markBody("Done.", "coder-agent"))).toBe("coder-agent")
    expect(agentAuthorOf("> 🤖 **coder-agent** (via AgentX)\n\nNothing new in this push.")).toBe("coder-agent")
  })

  it("is null for a person's comment, including one that quotes an agent mid-text", () => {
    expect(agentAuthorOf("Please fix the typo.")).toBeNull()
    expect(agentAuthorOf("I saw 🤖 **coder-agent** (via AgentX) say so above.")).toBeNull()
    expect(agentAuthorOf(undefined)).toBeNull()
  })

  it("gives agent:<id> for an agent's post and the account for a person", () => {
    const person = { id: "c", name: OWNER, username: OWNER }
    expect(forgeSender("Looks good to me", person)).toEqual(person)
    expect(forgeSender(agentComment("reviewer-agent", "x"), person)).toEqual({ id: "c", name: "agent:reviewer-agent", isBot: true })
  })

  it("counts an unattributed marker as our own echo", () => {
    expect(ownEchoOf(markBody("Error: boom", "unknown"), "coder-agent")).toBe("unknown")
    expect(agentAuthorOf(markBody("Error: boom", "unknown"))).toBeNull()
  })
})

describe("GitHub adapter — inbound", () => {
  let gh: GitHubAdapter
  let received: IncomingMessage[]

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 201, json: async () => ({}), text: async () => "" })))
    gh = new GitHubAdapter({ token: "t", routes: [{ repo: REPO, agent: "coder-agent" }] } as any, () => {})
    received = []
    gh.onMessage(async (m) => { received.push(m) })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const issueComment = (body: string) => ({
    action: "created",
    comment: { id: Math.floor(Math.random() * 1e6), body, user: { login: OWNER, id: 1 } },
    issue: { number: 12, title: "Add export", pull_request: {} },
    repository: { full_name: REPO, html_url: "u" },
  })

  const settle = () => new Promise((r) => setTimeout(r, 0))

  it("marks another agent's review, posted with the owner's token, as agent-sent", async () => {
    await (gh as any).handleIssueComment(issueComment(agentComment("reviewer-agent", "Verdict: NOT READY")))
    await settle()
    expect(received).toHaveLength(1)
    const m = received[0]
    expect(m.sender.name).toBe("agent:reviewer-agent")
    expect(m.sender.isBot).toBe(true)
    expect(m.text).toContain("reviewer-agent (an AgentX agent, posted with sam-owner's account) commented:")
    // What the registry sees as context: not a person starting work.
    expect(classifyInitiator({ channel: "github", sender: m.sender.name })).toBe("agent")
  })

  it("marks a header-only agent post as agent-sent", async () => {
    await (gh as any).handleIssueComment(issueComment("> 🤖 **reviewer-agent** (via AgentX)\n\nChecked the head."))
    await settle()
    expect(received[0].sender.name).toBe("agent:reviewer-agent")
  })

  it("keeps the owner's own comment as the owner, a person", async () => {
    await (gh as any).handleIssueComment(issueComment("@coder-agent please rebase"))
    await settle()
    expect(received[0].sender).toMatchObject({ name: OWNER, username: OWNER })
    expect(classifyInitiator({ channel: "github", sender: received[0].sender.name })).toBe("human")
  })

  it("drops its own agent's echo and an unattributed one", async () => {
    await (gh as any).handleIssueComment(issueComment(agentComment("coder-agent", "Done.")))
    await (gh as any).handleIssueComment(issueComment(markBody("Error: boom", "unknown")))
    await settle()
    expect(received).toHaveLength(0)
  })

  it("marks an agent's PR review as agent-sent and drops its own", async () => {
    const review = (body: string) => ({
      action: "submitted",
      review: { id: 5, body, state: "commented", user: { login: OWNER, id: 1 } },
      pull_request: { number: 12, title: "Add export" },
      repository: { full_name: REPO, html_url: "u" },
    })
    await (gh as any).handlePRReview(review(agentComment("coder-agent", "self")))
    await (gh as any).handlePRReview(review(agentComment("reviewer-agent", "Verdict: READY")))
    await settle()
    expect(received).toHaveLength(1)
    expect(received[0].sender.name).toBe("agent:reviewer-agent")
  })
})

describe("GitHub adapter — outbound", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it("signs every comment with the header and the marker", async () => {
    const posted: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => {
      posted.push(JSON.parse(init.body).body)
      return { ok: true, status: 201, json: async () => ({ id: 99 }), text: async () => "" }
    }))
    const gh = new GitHubAdapter({ token: "t", routes: [{ repo: REPO, agent: "coder-agent" }] } as any, () => {})
    ;(gh as any).globalToken = "t" // start() resolves it; no server here
    await gh.send({ channel: "github", chatId: `${REPO}:pull:12`, text: "Checked it.", agentId: "coder-agent" } as any)
    expect(posted).toHaveLength(1)
    expect(detectAgentxMarker(posted[0])).toBe("coder-agent")
    expect(agentAuthorOf(posted[0])).toBe("coder-agent")
  })
})

describe("GitLab adapter", () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function makeGitLab(fetchImpl: any) {
    vi.stubGlobal("fetch", vi.fn(fetchImpl))
    const gl = new GitLabAdapter({
      webhookPort: 0,
      host: "https://gitlab.example.test",
      token: "global",
      routes: [],
      agentMappings: [],
    } as any, () => {})
    ;(gl as any).usernameToAgent.set("coder_bot", "coder-agent")
    ;(gl as any).usernameToAgent.set("reviewer_bot", "reviewer-agent")
    return gl
  }

  const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
  const note = (body: string, username = OWNER) => ({
    object_kind: "note",
    object_attributes: { id: Math.floor(Math.random() * 1e6), note: body, noteable_type: "Issue" },
    project: { path_with_namespace: REPO },
    user: { username, name: "Sam Owner" },
    issue: { iid: 4, title: "Add export" },
  })

  it("marks a signed handoff note, posted with a person's token, as agent-sent", async () => {
    const gl = makeGitLab(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" }))
    const received: IncomingMessage[] = []
    gl.onMessage(async (m) => { received.push(m) })
    await (gl as any).handleNote(note(markBody("@coder_bot over to you", "reviewer-agent")), res())
    expect(received).toHaveLength(1)
    expect(received[0].sender.name).toBe("agent:reviewer-agent")
    expect(classifyInitiator({ channel: "gitlab", sender: received[0].sender.name })).toBe("agent")
  })

  it("keeps a person's note as the person", async () => {
    const gl = makeGitLab(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" }))
    const received: IncomingMessage[] = []
    gl.onMessage(async (m) => { received.push(m) })
    await (gl as any).handleNote(note("@coder_bot please look"), res())
    expect(received[0].sender).toMatchObject({ name: "Sam Owner", username: OWNER })
  })

  it("signs every note it posts", async () => {
    const posted: string[] = []
    const gl = makeGitLab(async (_u: any, init: any) => {
      if (init?.body) posted.push(JSON.parse(init.body).body)
      return { ok: true, status: 201, json: async () => ({ id: 7 }), text: async () => "" }
    })
    await gl.send({ channel: "gitlab", chatId: `${REPO}:issue:4`, text: "On it.", agentId: "coder-agent" } as any)
    expect(posted).toHaveLength(1)
    expect(detectAgentxMarker(posted[0])).toBe("coder-agent")
  })
})

describe("router replies name their agent, so the adapter signs them", () => {
  it("passes the agent id on mesh replies and on error replies", async () => {
    const adapter: any = { name: "github", send: vi.fn(async () => "1"), react: vi.fn(), sendTyping: vi.fn() }
    const router = new MessageRouter({ getAgent: () => undefined } as any, { channels: {} } as any, undefined, () => {})
    const sendTask = vi.fn(async () => "Checked the head.")
    router.setMesh({
      directory: () => [{ peer: "peer-one", peerUrl: "u", healthy: true, skills: [{ id: "reviewer-agent", name: "reviewer-agent" }], channels: [] }],
      findAgentPeer: () => ({ peer: "peer-one", healthy: true }),
      sendTask,
      onPeerChange: () => {},
    } as any)
    const msg = {
      id: "n1", channel: "github", accountId: "default",
      sender: { id: `${REPO}:pull:12`, name: OWNER, username: OWNER },
      text: "please review", group: undefined,
    } as any
    await (router as any).handleViaMeshByAgentId(adapter, msg, "reviewer-agent")
    await (router as any).handleViaMesh(adapter, { ...msg, text: "reviewer-agent please review" })
    expect(adapter.send).toHaveBeenCalledTimes(2)
    for (const [out] of adapter.send.mock.calls) expect(out.agentId).toBe("reviewer-agent")
  })
})

describe("wiki fact capture skips agent senders", () => {
  it("records no contact for agent:<id>", () => {
    const records = recordsFromEntries([
      { source: "github", meta: { sender: "agent:reviewer-agent", senderUsername: OWNER } },
      { source: "github", meta: { sender: OWNER, senderUsername: OWNER } },
    ])
    expect(records.map((r) => r.name)).toEqual([OWNER])
  })
})
