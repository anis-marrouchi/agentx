import { describe, it, expect, vi, afterEach } from "vitest"
import { GitLabAdapter, GitLabWriteError, gitlabErrorDetail } from "../src/channels/gitlab"
import { MessageRouter } from "../src/channels/router"
import { sendAnswer, sendResultText } from "../src/daemon/send-answer"

// #984: an agent with no GitLab token of its own posts with the shared
// global token. Once GitLab revoked that token every note failed with 401,
// yet agentx_send answered "Message sent. ID: ok". Each step of the path
// (adapter → router → /send answer → agentx_send text) must carry the
// failure through.

const HOST = "https://gitlab.example.com"
const REVOKED = JSON.stringify({ error: "invalid_token", error_description: "Token was revoked. You have to re-authorize from the user." })

function revokedFetch() {
  return vi.fn(async () => ({ ok: false, status: 401, text: async () => REVOKED, json: async () => JSON.parse(REVOKED) }))
}

function adapter() {
  return new GitLabAdapter({ host: HOST, token: "global-token", webhookPort: 0, routes: [] } as any, () => {})
}

afterEach(() => vi.unstubAllGlobals())

describe("GitLab writes with a revoked global token", () => {
  it("send throws with the status and GitLab's message, naming the fallback", async () => {
    vi.stubGlobal("fetch", revokedFetch())
    const err = await adapter().send({ channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi", agentId: "helper-agent" }).catch((e) => e)
    expect(err).toBeInstanceOf(GitLabWriteError)
    expect(err.status).toBe(401)
    expect(err.globalToken).toBe(true)
    expect(err.message).toContain("401")
    expect(err.message).toContain("Token was revoked")
    expect(err.message).toContain("shared global GitLab token")
  })

  it("marks the global token rejected in token health, and a later success clears it", async () => {
    const gl = adapter()
    vi.stubGlobal("fetch", revokedFetch())
    await gl.send({ channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi", agentId: "helper-agent" }).catch(() => {})
    expect(gl.tokenHealth().global).toMatchObject({ ok: false, status: 401, error: expect.stringContaining("revoked") })

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ id: 55 }), text: async () => "" })))
    expect(await gl.send({ channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi", agentId: "helper-agent" })).toBe("55")
    expect(gl.tokenHealth().global?.ok).toBe(true)
  })

  it("start() records a revoked global token from the /user check", async () => {
    vi.stubGlobal("fetch", revokedFetch())
    const gl = adapter()
    await gl.start()
    await gl.stop()
    expect(gl.tokenHealth().global).toMatchObject({ ok: false, status: 401 })
  })

  it("a 403 is about the project, not the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => '{"message":"403 Forbidden"}' })))
    const gl = adapter()
    await expect(gl.send({ channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi" })).rejects.toThrow("403 403 Forbidden")
    expect(gl.tokenHealth().global).toBeUndefined()
  })

  it("time-log, issue-create, labels and assignees all throw the same way", async () => {
    vi.stubGlobal("fetch", revokedFetch())
    const gl = adapter()
    const agentId = "helper-agent"
    await expect(gl.logTimeSpent("acme/widgets:issue:7", 120_000, agentId)).rejects.toThrow(/time-log failed: 401 Token was revoked/)
    await expect(gl.createIssue({ project: "acme/widgets", title: "t", agentId })).rejects.toThrow(/issue-create failed: 401 Token was revoked/)
    await expect(gl.setLabels({ project: "acme/widgets", iid: "7", add: ["x"], agentId })).rejects.toThrow(/label change failed: 401 Token was revoked/)
    await expect(gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: ["sam"], agentId })).rejects.toThrow(/assignee change failed: 401 Token was revoked/)
    await expect(gl.setAssignees({ project: "acme/widgets", iid: "7", assignees: [], agentId })).rejects.toThrow(/assignee change failed: 401/)
  })

  it("a bad chatId is an error, not an empty ID", async () => {
    await expect(adapter().send({ channel: "gitlab", chatId: "nonsense", text: "hi" })).rejects.toThrow(/Invalid GitLab chatId/)
    await expect(adapter().send({ channel: "gitlab", chatId: "acme/widgets:epic:1", text: "hi" })).rejects.toThrow(/Unsupported GitLab chat type/)
  })

  it("reports the posting identity", () => {
    const gl = new GitLabAdapter({ host: HOST, token: "g", webhookPort: 0, routes: [], agentMappings: [
      { agentId: "own-agent", token: "t", gitlabUsernames: [] },
      { agentId: "far-agent", node: "peer-b", gitlabUsernames: [] },
    ] } as any, () => {})
    expect(gl.postingIdentity("own-agent")).toBe("agent")
    expect(gl.postingIdentity("far-agent")).toBe("peer")
    expect(gl.postingIdentity("helper-agent")).toBe("global")
  })
})

describe("revoked token end to end: channel → router → /send → agentx_send", () => {
  it("the agent reads an error naming 401 and the revoked token", async () => {
    vi.stubGlobal("fetch", revokedFetch())
    const router = new MessageRouter({ getAgent: () => undefined, refusalFor: () => null } as any, { channels: {} } as any, undefined, () => {})
    router.addChannel(adapter())

    // POST /send: a thrown send is answered 400 with the message.
    let status = 200
    let body: Record<string, unknown>
    try {
      const messageId = await router.sendOutbound({ channel: "gitlab", chatId: "acme/widgets:issue:7", text: "hi", agentId: "helper-agent" })
      const answer = sendAnswer(messageId, { channel: "gitlab", agentId: "helper-agent", identity: "global" })
      status = answer.status
      body = answer.body
    } catch (e: any) {
      status = 400
      body = { error: e.message }
    }
    expect(status).toBe(400)
    const text = sendResultText(false, body)
    expect(text).toMatch(/^Error: GitLab note failed: 401 Token was revoked/)
    expect(text).not.toContain("Message sent")
  })
})

describe("sendAnswer / sendResultText", () => {
  it("a send with no message ID is not ok", () => {
    const a = sendAnswer(undefined, { channel: "gitlab" })
    expect(a.status).toBe(502)
    expect(a.body.ok).toBe(false)
    expect(sendResultText(false, a.body)).toMatch(/^Error: The gitlab channel returned no message ID/)
    expect(sendAnswer("", { channel: "telegram" }).body.ok).toBe(false)
  })

  it("never prints ok in place of a missing ID", () => {
    expect(sendResultText(true, { messageId: null })).toBe("Error: the message was not confirmed as sent")
    expect(sendResultText(true, { messageId: "12" })).toBe("Message sent. ID: 12")
  })

  it("says when the shared global token was used", () => {
    const a = sendAnswer("12", { channel: "gitlab", agentId: "helper-agent", identity: "global" })
    expect(a.body).toMatchObject({ ok: true, messageId: "12", identity: "global" })
    expect(sendResultText(true, a.body)).toMatch(/Message sent. ID: 12\nWarning: Posted with the shared global gitlab token/)
    expect(sendAnswer("12", { channel: "gitlab", agentId: "own-agent", identity: "agent" }).body.warning).toBeUndefined()
  })
})

describe("gitlabErrorDetail", () => {
  it("prefers OAuth's description, then the API message, then the raw text", () => {
    expect(gitlabErrorDetail(REVOKED)).toBe("Token was revoked. You have to re-authorize from the user.")
    expect(gitlabErrorDetail('{"message":"401 Unauthorized"}')).toBe("401 Unauthorized")
    expect(gitlabErrorDetail('{"message":{"labels":["bad"]}}')).toBe('{"labels":["bad"]}')
    expect(gitlabErrorDetail("<html>bad gateway</html>")).toBe("<html>bad gateway</html>")
    expect(gitlabErrorDetail("")).toBe("no response body")
  })
})
