import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"
import type { IncomingMessage } from "../src/channels/types"

// #2070: handleMR dropped MR events whose actor is an agent account with no
// log line, so an agent-opened MR that woke nothing left no trace.

const REPO = "acme/api"

function adapter() {
  const logs: string[] = []
  const gl = new GitLabAdapter({
    webhookPort: 0,
    host: "https://gitlab.example.test",
    token: "global",
    routes: [{ project: REPO, agent: "coder-agent" }],
  } as GitLabChannelConfig, (...args) => logs.push(args.join(" ")))
  ;(gl as any).botUsernames.add("coder_bot")
  const runs: IncomingMessage[] = []
  gl.onMessage(async (m) => { runs.push(m) })
  return { gl, runs, logs }
}

const res = () => ({ writeHead: vi.fn(), end: vi.fn() })
const mr = (username: string) => ({
  object_kind: "merge_request",
  user: { username, name: username },
  project: { path_with_namespace: REPO },
  object_attributes: { iid: 12, title: "Fix", description: "", state: "opened", action: "open", url: "", source_branch: "f", target_branch: "main", labels: [] },
})

describe("GitLab: bot MR events", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it("an MR opened by an agent account is skipped, and the log says so", async () => {
    const { gl, runs, logs } = adapter()
    const r = res()
    await (gl as any).handleMR(mr("coder_bot"), r)
    expect(runs).toHaveLength(0)
    expect(r.writeHead).toHaveBeenCalledWith(200)
    expect(logs.some((l) => l.includes(`MR !12 on ${REPO} "open" by bot "coder_bot"`) && l.includes("skipped"))).toBe(true)
  })

  it("an MR opened by a person writes no bot-skip line", async () => {
    const { gl, logs } = adapter()
    await (gl as any).handleMR(mr("sam"), res())
    expect(logs.some((l) => l.includes("by bot"))).toBe(false)
  })
})
