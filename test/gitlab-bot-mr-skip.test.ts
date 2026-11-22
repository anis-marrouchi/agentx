import { afterEach, describe, expect, it, vi } from "vitest"
import { GitLabAdapter } from "../src/channels/gitlab"

// #2070: a bot-actor MR event is still dropped (cascade prevention), but it
// now leaves a log line so the miss does not look like a lost webhook.
describe("GitLab MR events from a bot account", () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const BOT = "agentx_bot"

  function makeGitLab() {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })))
    const lines: string[] = []
    const gl = new GitLabAdapter({
      webhookPort: 0, host: "https://gitlab.example.test", token: "global", routes: [],
      agentMappings: [{ agentId: "reviewer-agent", gitlabUsernames: [BOT], keywords: [] }],
    } as any, (...args: unknown[]) => { lines.push(args.map(String).join(" ")) })
    // start() registers mapped usernames as bots; the test skips start().
    ;(gl as any).botUsernames.add(BOT)
    const handler = vi.fn(async () => {})
    gl.onMessage(handler)
    return { gl, lines, handler }
  }
  const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
  const mr = (username: string, action: string) => ({
    object_kind: "merge_request",
    user: { username, name: username },
    project: { path_with_namespace: "acme/web" },
    object_attributes: { iid: 7, action, title: "t", description: "", state: "opened", url: "https://gitlab.example.test/acme/web/-/merge_requests/7" },
  })

  it("does not call the handler and logs project, !iid, action and user", async () => {
    const { gl, lines, handler } = makeGitLab()
    const r = res()
    await (gl as any).handleMR(mr(BOT, "open"), r)
    expect(handler).not.toHaveBeenCalled()
    expect(r.writeHead).toHaveBeenCalledWith(200)
    expect(lines).toContain(`MR !7 on acme/web "open" by bot "${BOT}" — skipped (cascade prevention)`)
  })

  it("writes no skip line for a human actor", async () => {
    const { gl, lines } = makeGitLab()
    await (gl as any).handleMR(mr("sam", "open"), res())
    expect(lines.some((l) => l.includes("skipped (cascade prevention)"))).toBe(false)
  })
})
