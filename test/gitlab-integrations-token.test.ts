import { describe, it, expect, vi, afterEach } from "vitest"
import { GitLabAdapter, GitLabWriteError } from "../src/channels/gitlab"
import { gitlabIntegrationToken, resolveGitlabTokenForAgent } from "../src/channels/gitlab-token"

// #1745 cause 3: an agent whose GitLab token is declared in
// agents[id].integrations[] (kind gitlab-user, tokenEnv) must post with that
// token, not the shared global one. A per-agent token that lacks access to
// the project falls back once to the global token, with a log line.

const HOST = "https://gitlab.example.com"
const CHAT = "acme/widgets:issue:7"

type Call = { url: string; method: string; token: string }

function recordingFetch(statusFor: (token: string, method: string) => number) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init: any) => {
    const token = init?.headers?.["PRIVATE-TOKEN"]
    const method = init?.method || "GET"
    calls.push({ url, method, token })
    const status = statusFor(token, method)
    const ok = status >= 200 && status < 300
    const body = ok ? { id: 55, labels: ["doing"] } : { message: `${status} Forbidden` }
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }
  })
  return { fn, calls }
}

function adapter(opts: { mappings?: any[]; integrationTokens?: Record<string, string> } = {}) {
  const logs: string[] = []
  const gl = new GitLabAdapter({
    host: HOST,
    token: "global-token",
    webhookPort: 0,
    routes: [],
    agentMappings: opts.mappings,
    integrationToken: (id: string) => opts.integrationTokens?.[id],
  } as any, (m: string) => logs.push(m))
  return { gl, logs }
}

afterEach(() => vi.unstubAllGlobals())

describe("GitLab writes with an agent's integrations token", () => {
  it("posts a note with the integrations token when agentMappings has none", async () => {
    const { fn, calls } = recordingFetch(() => 201)
    vi.stubGlobal("fetch", fn)
    const { gl, logs } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    expect(await gl.send({ channel: "gitlab", chatId: CHAT, text: "hi", agentId: "helper-agent" })).toBe("55")
    expect(calls.map((c) => c.token)).toEqual(["helper-token"])
    expect(gl.postingIdentity("helper-agent")).toBe("agent")
    expect(logs.some((l) => l.includes("GLOBAL token"))).toBe(false)
  })

  it("keeps agentMappings[].token ahead of the integrations token", async () => {
    const { fn, calls } = recordingFetch(() => 201)
    vi.stubGlobal("fetch", fn)
    const { gl } = adapter({
      mappings: [{ agentId: "helper-agent", gitlabUsernames: [], keywords: [], token: "mapping-token" }],
      integrationTokens: { "helper-agent": "helper-token" },
    })
    await gl.send({ channel: "gitlab", chatId: CHAT, text: "hi", agentId: "helper-agent" })
    expect(calls.map((c) => c.token)).toEqual(["mapping-token"])
  })

  it("keeps an explicit agentMappings[].node ahead of the integrations token", async () => {
    const { fn, calls } = recordingFetch(() => 201)
    vi.stubGlobal("fetch", fn)
    const { gl } = adapter({
      mappings: [{ agentId: "helper-agent", gitlabUsernames: [], keywords: [], node: "peer-b" }],
      integrationTokens: { "helper-agent": "helper-token" },
    })
    const forwarder = vi.fn(async () => "77")
    gl.setSendNoteForwarder(forwarder)
    expect(await gl.send({ channel: "gitlab", chatId: CHAT, text: "hi", agentId: "helper-agent" })).toBe("77")
    expect(forwarder).toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("on 403 with the integrations token, retries the note once with the global token and logs it", async () => {
    const { fn, calls } = recordingFetch((token) => token === "helper-token" ? 403 : 201)
    vi.stubGlobal("fetch", fn)
    const { gl, logs } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    expect(await gl.send({ channel: "gitlab", chatId: CHAT, text: "hi", agentId: "helper-agent" })).toBe("55")
    expect(calls.map((c) => c.token)).toEqual(["helper-token", "global-token"])
    const line = logs.find((l) => l.startsWith("[gitlab/identity]") && l.includes("403"))
    expect(line).toBeDefined()
    expect(line).toContain("helper-agent")
    expect(line).toContain("acme/widgets")
  })

  it("retries a note edit and a label change on 401/404 the same way", async () => {
    const { fn, calls } = recordingFetch((token) => token === "helper-token" ? 404 : 200)
    vi.stubGlobal("fetch", fn)
    const { gl, logs } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    expect(await gl.editComment(CHAT, "12", "new text", "helper-agent")).toBe(true)
    expect(await gl.setLabels({ project: "acme/widgets", iid: "7", add: ["doing"], agentId: "helper-agent" })).toEqual(["doing"])
    expect(calls.map((c) => c.token)).toEqual(["helper-token", "global-token", "helper-token", "global-token"])
    expect(logs.filter((l) => l.startsWith("[gitlab/identity]") && l.includes("404"))).toHaveLength(2)

    calls.length = 0
    vi.stubGlobal("fetch", recordingFetch((token) => token === "helper-token" ? 401 : 200).fn)
    expect(await gl.setLabels({ project: "acme/widgets", iid: "7", add: ["doing"], agentId: "helper-agent" })).toEqual(["doing"])
    expect(gl.tokenHealth().agents["helper-agent"]).toMatchObject({ ok: false, status: 401 })
  })

  it("does not retry other errors", async () => {
    const { fn, calls } = recordingFetch((token) => token === "helper-token" ? 500 : 201)
    vi.stubGlobal("fetch", fn)
    const { gl } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    const err = await gl.send({ channel: "gitlab", chatId: CHAT, text: "hi", agentId: "helper-agent" }).catch((e) => e)
    expect(err).toBeInstanceOf(GitLabWriteError)
    expect(err.status).toBe(500)
    expect(calls.map((c) => c.token)).toEqual(["helper-token"])
  })

  it("does not retry a refused agentMappings token (unchanged behaviour)", async () => {
    const { fn, calls } = recordingFetch((token) => token === "mapping-token" ? 403 : 201)
    vi.stubGlobal("fetch", fn)
    const { gl } = adapter({ mappings: [{ agentId: "helper-agent", gitlabUsernames: [], keywords: [], token: "mapping-token" }] })
    await expect(gl.send({ channel: "gitlab", chatId: CHAT, text: "hi", agentId: "helper-agent" })).rejects.toThrow("403")
    expect(calls.map((c) => c.token)).toEqual(["mapping-token"])
  })

  it("leaves callers with no agent id on the global token", async () => {
    const { fn, calls } = recordingFetch(() => 201)
    vi.stubGlobal("fetch", fn)
    const integrationToken = vi.fn(() => "helper-token")
    const gl = new GitLabAdapter({ host: HOST, token: "global-token", webhookPort: 0, routes: [], integrationToken } as any, () => {})
    await gl.send({ channel: "gitlab", chatId: CHAT, text: "hi" })
    expect(calls.map((c) => c.token)).toEqual(["global-token"])
    expect(integrationToken).not.toHaveBeenCalled()
    expect(gl.postingIdentity(undefined)).toBe("global")
  })
})

describe("shared GitLab token resolution", () => {
  const config = (env: string | undefined) => ({
    channels: { gitlab: { token: "global-token", agentMappings: [{ agentId: "mapped-agent", token: "mapping-token" }] } },
    agents: {
      "helper-agent": { integrations: [{ kind: "gitlab-user", label: "gitlab-user", credentials: { tokenEnv: "HELPER_GITLAB_TOKEN_TEST" } }] },
      "mapped-agent": {},
    },
  } as any)

  afterEach(() => { delete process.env.HELPER_GITLAB_TOKEN_TEST })

  it("reads an agent's gitlab-user integration token from its env var", () => {
    process.env.HELPER_GITLAB_TOKEN_TEST = "helper-token"
    expect(gitlabIntegrationToken(config(undefined), "helper-agent")).toEqual({ token: "helper-token", source: "integrations(HELPER_GITLAB_TOKEN_TEST)" })
    expect(resolveGitlabTokenForAgent(config(undefined), "helper-agent").token).toBe("helper-token")
  })

  it("orders agentMappings, then integrations, then the global token", () => {
    expect(resolveGitlabTokenForAgent(config(undefined), "mapped-agent")).toEqual({ token: "mapping-token", source: "agentMappings" })
    expect(resolveGitlabTokenForAgent(config(undefined), "helper-agent")).toEqual({ token: "global-token", source: "global" })
    expect(resolveGitlabTokenForAgent(config(undefined), undefined)).toEqual({ token: "global-token", source: "global" })
  })
})

// #1774: assign, relate and react skipped the integrations token, and a
// refused one on a reaction was not retried with the global token.
describe("assign, relate and react with an agent's integrations token", () => {
  function fetchWith(statusFor: (token: string, method: string, url: string) => number) {
    const calls: Call[] = []
    const fn = vi.fn(async (url: string, init: any) => {
      const token = init?.headers?.["PRIVATE-TOKEN"]
      const method = init?.method || "GET"
      calls.push({ url, method, token })
      const status = statusFor(token, method, url)
      const ok = status >= 200 && status < 300
      const body = url.includes("/users?username=") ? [{ id: 9, username: "dana" }] : ok ? { id: 1 } : { message: `${status} Forbidden` }
      return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }
    })
    return { fn, calls }
  }
  const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET")

  it("assigns and relates under the agent's own token", async () => {
    const { fn, calls } = fetchWith(() => 200)
    vi.stubGlobal("fetch", fn)
    const { gl, logs } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    expect(await gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: ["dana"], agentId: "helper-agent" })).toEqual([9])
    expect(await gl.relateIssue({ project: "acme/widgets", sourceIid: "7", targetIid: "8", agentId: "helper-agent" })).toBe(true)
    expect(writes(calls).map((c) => c.token)).toEqual(["helper-token", "helper-token"])
    expect(logs.some((l) => l.includes("GLOBAL token"))).toBe(false)
  })

  it("retries a refused integrations token once with the global token on assign, relate and react, and logs it", async () => {
    const { fn, calls } = fetchWith((token, method) => (method !== "GET" && token === "helper-token" ? 403 : 200))
    vi.stubGlobal("fetch", fn)
    const { gl, logs } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    expect(await gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: ["dana"], agentId: "helper-agent" })).toEqual([9])
    expect(await gl.relateIssue({ project: "acme/widgets", sourceIid: "7", targetIid: "8", agentId: "helper-agent" })).toBe(true)
    await gl.react(CHAT, "123", "✅", "helper-agent")
    expect(writes(calls).map((c) => c.token)).toEqual([
      "helper-token", "global-token", // assign
      "helper-token", "global-token", // relate
      "helper-token", "global-token", // react
    ])
    const identity = logs.filter((l) => l.startsWith("[gitlab/identity]") && l.includes("retrying once with GLOBAL token"))
    expect(identity).toHaveLength(3)
    expect(identity.map((l) => l.split(" from ")[0])).toEqual(["[gitlab/identity] setAssignees", "[gitlab/identity] relateIssue", '[gitlab/identity] react "white_check_mark"'])
  })

  it("looks assignees up with the global token when the agent has an integrations token", async () => {
    const { fn, calls } = fetchWith(() => 200)
    vi.stubGlobal("fetch", fn)
    const { gl } = adapter({ integrationTokens: { "helper-agent": "helper-token" } })
    await gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: ["dana"], agentId: "helper-agent" })
    expect(calls.filter((c) => c.method === "GET").map((c) => c.token)).toEqual(["global-token"])
  })

  it("leaves agentMappings tokens and callers without an agent id as before", async () => {
    const { fn, calls } = fetchWith((token, method) => (method !== "GET" && token === "mapping-token" ? 403 : 200))
    vi.stubGlobal("fetch", fn)
    const { gl } = adapter({
      mappings: [{ agentId: "helper-agent", gitlabUsernames: [], keywords: [], token: "mapping-token" }],
      integrationTokens: { "helper-agent": "helper-token" },
    })
    await expect(gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: ["dana"], agentId: "helper-agent" })).rejects.toBeInstanceOf(GitLabWriteError)
    expect(await gl.relateIssue({ project: "acme/widgets", sourceIid: "7", targetIid: "8", agentId: "helper-agent" })).toBe(false)
    expect(calls.map((c) => c.token)).toEqual(["mapping-token", "mapping-token", "mapping-token"])
    calls.length = 0
    expect(await gl.relateIssue({ project: "acme/widgets", sourceIid: "7", targetIid: "8" })).toBe(true)
    expect(await gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: ["dana"] })).toEqual([9])
    expect(calls.map((c) => c.token)).toEqual(["global-token", "global-token", "global-token"])
  })
})
