import { describe, it, expect, vi, afterEach } from "vitest"
import { NtfyAdapter } from "../src/channels/ntfy"

function mockFetch(status = 200, body: unknown = { id: "msg-1" }) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }))
  ;(globalThis as any).fetch = fn
  return fn
}

const quiet = () => {}

afterEach(() => { vi.restoreAllMocks() })

describe("NtfyAdapter", () => {
  it("posts to the default topic and returns the message id", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "secret-topic" }, quiet)

    const id = await a.send({ channel: "ntfy", chatId: "", text: "something broke" })

    expect(id).toBe("msg-1")
    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe("https://ntfy.sh/secret-topic")
    expect(init.method).toBe("POST")
    expect(init.body).toBe("something broke")
  })

  it("treats the \"default\" sentinel as the configured topic, so agents never carry it", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "secret-topic" }, quiet)

    await a.send({ channel: "ntfy", chatId: "default", text: "hi" })

    expect((fetchMock.mock.calls[0] as any)[0]).toBe("https://ntfy.sh/secret-topic")
  })

  it("routes to an explicit topic when chatId is set", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "fallback", server: "https://ntfy.example.com/" }, quiet)

    await a.send({ channel: "ntfy", chatId: "urgent", text: "hi" })

    expect((fetchMock.mock.calls[0] as any)[0]).toBe("https://ntfy.example.com/urgent")
  })

  it("promotes a short first line to the notification title", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "MR 214 needs review\nBlocked since Tuesday." })

    const init = (fetchMock.mock.calls[0] as any)[1]
    expect(init.headers["Title"]).toBe("MR 214 needs review")
    expect(init.body).toBe("Blocked since Tuesday.")
  })

  it("keeps a single-line message whole and falls back to the default title", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t", defaultTitle: "Secretary" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "just one line" })

    const init = (fetchMock.mock.calls[0] as any)[1]
    expect(init.headers["Title"]).toBe("Secretary")
    expect(init.body).toBe("just one line")
  })

  it("does not steal a long first line as a title", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)
    const long = "x".repeat(100)

    await a.send({ channel: "ntfy", chatId: "", text: `${long}\nrest` })

    const init = (fetchMock.mock.calls[0] as any)[1]
    expect(init.headers["Title"]).toBe("AgentX")
    expect(init.body).toBe(`${long}\nrest`)
  })

  it("RFC 2047-encodes non-ASCII titles, which ntfy headers cannot carry raw", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "Échéance dépassée\nbody" })

    const title = (fetchMock.mock.calls[0] as any)[1].headers["Title"]
    expect(title).toMatch(/^=\?UTF-8\?B\?/)
    const b64 = title.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, "")
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("Échéance dépassée")
  })

  it("maps url buttons onto ntfy view actions, capped at three", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await a.send({
      channel: "ntfy", chatId: "", text: "check this",
      buttons: [
        { label: "Open MR", url: "https://gitlab.example.com/a/b/-/merge_requests/1" },
        { label: "Issue", url: "https://gitlab.example.com/a/b/-/issues/2" },
        { label: "Pipeline", url: "https://gitlab.example.com/a/b/-/pipelines/3" },
        { label: "Dropped", url: "https://example.com" },
      ],
    })

    const actions = (fetchMock.mock.calls[0] as any)[1].headers["Actions"]
    expect(actions.split(";")).toHaveLength(3)
    expect(actions).toContain("view, Open MR, https://gitlab.example.com/a/b/-/merge_requests/1")
    expect(actions).not.toContain("Dropped")
  })

  it("sends the access token for protected topics", async () => {
    const fetchMock = mockFetch()
    const a = new NtfyAdapter({ topic: "t", token: "tk_123" }, quiet)

    await a.send({ channel: "ntfy", chatId: "", text: "hi" })

    expect((fetchMock.mock.calls[0] as any)[1].headers["Authorization"]).toBe("Bearer tk_123")
  })

  it("throws with the server's detail when ntfy rejects the publish", async () => {
    mockFetch(403, { error: "forbidden" })
    const a = new NtfyAdapter({ topic: "t" }, quiet)

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/403/)
  })

  it("refuses to send when no topic is resolvable", async () => {
    mockFetch()
    const a = new NtfyAdapter({ topic: "" }, quiet)

    await expect(a.send({ channel: "ntfy", chatId: "", text: "hi" })).rejects.toThrow(/no topic/)
  })
})
