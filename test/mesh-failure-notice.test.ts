import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { GitLabAdapter, type GitLabChannelConfig } from "../src/channels/gitlab"
import { cleanMeshError } from "../src/channels/router"

// Outcome reactions (❌ / ✅ / ⚠️) used to post with the GLOBAL gitlab token,
// on the reasoning that a mesh failure has no meaningful agent attribution.
// In practice the router always knows which agent the note was routed to, and
// the global token belongs to some *other* bot — so a failure on a thread that
// @-mentioned @noqta_coder_bot showed a ❌ authored by @devops-noqta, and the
// reporter concluded the wrong bot was ignoring them (noqta/minbar#46).
//
// These tests pin the identity: react() posts as the named agent whenever that
// agent's identity is resolvable, and only falls back to the global token when
// it genuinely isn't.

const GLOBAL_TOKEN = "glpat-global-token"
const CODER_TOKEN = "glpat-coder-token"

function makeConfig(overrides: Partial<GitLabChannelConfig> = {}): GitLabChannelConfig {
  return {
    webhookPort: 0,
    host: "https://gitlab.example.test",
    token: GLOBAL_TOKEN,
    routes: [],
    agentMappings: [
      { agentId: "coder-agent", gitlabUsernames: ["noqta_coder_bot"], keywords: [], token: CODER_TOKEN },
      { agentId: "remote-agent", gitlabUsernames: ["noqta_remote_bot"], keywords: [], node: "macbook-local" },
    ],
    ...overrides,
  }
}

/** Capture every outbound award_emoji POST. */
function stubFetch() {
  const calls: Array<{ url: string; token?: string; name?: string }> = []
  const fake = vi.fn(async (url: any, init: any) => {
    calls.push({
      url: String(url),
      token: init?.headers?.["PRIVATE-TOKEN"],
      name: init?.body ? JSON.parse(init.body).name : undefined,
    })
    return { ok: true, status: 201, text: async () => "{}", json: async () => ({}) } as any
  })
  vi.stubGlobal("fetch", fake)
  return calls
}

describe("GitLabAdapter.react — reaction identity", () => {
  let calls: ReturnType<typeof stubFetch>

  beforeEach(() => { calls = stubFetch() })
  afterEach(() => { vi.unstubAllGlobals() })

  it("posts ❌ with the agent's own token, not the global one", async () => {
    const gl = new GitLabAdapter(makeConfig(), () => {})

    await gl.react("noqta/minbar:issue:46", "104670", "❌", "coder-agent")

    expect(calls).toHaveLength(1)
    expect(calls[0].token).toBe(CODER_TOKEN)
    expect(calls[0].token).not.toBe(GLOBAL_TOKEN)
    expect(calls[0].name).toBe("x")
    expect(calls[0].url).toContain("/issues/46/notes/104670/award_emoji")
  })

  it("forwards to the mesh peer that holds the identity, carrying the emoji", async () => {
    const gl = new GitLabAdapter(makeConfig(), () => {})
    const forwarded: any[] = []
    gl.setReactForwarder(async (...args) => { forwarded.push(args) })

    await gl.react("noqta/minbar:issue:46", "104670", "❌", "remote-agent")

    // Nothing posted locally — the peer owns the token.
    expect(calls).toHaveLength(0)
    expect(forwarded).toHaveLength(1)
    const [node, project, noteableType, noteableIid, noteId, agentId, name] = forwarded[0]
    expect(node).toBe("macbook-local")
    expect(project).toBe("noqta/minbar")
    expect(noteableType).toBe("issue")
    expect(noteableIid).toBe("46")
    expect(noteId).toBe(104670)
    expect(agentId).toBe("remote-agent")
    // Regression: the forwarder used to hardcode "eyes" on the far side, so a
    // ❌ crossing a mesh hop silently rendered as a 👀 ack.
    expect(name).toBe("x")
  })

  it("falls back to the global token when no agent is known", async () => {
    const gl = new GitLabAdapter(makeConfig(), () => {})

    await gl.react("noqta/minbar:issue:46", "104670", "❌")

    expect(calls).toHaveLength(1)
    expect(calls[0].token).toBe(GLOBAL_TOKEN)
    expect(calls[0].name).toBe("x")
  })

  it("falls back to the global token when the agent has no mapping", async () => {
    const gl = new GitLabAdapter(makeConfig(), () => {})

    await gl.react("noqta/minbar:issue:46", "104670", "⚠️", "unmapped-agent")

    expect(calls).toHaveLength(1)
    expect(calls[0].token).toBe(GLOBAL_TOKEN)
    expect(calls[0].name).toBe("warning")
  })

  it("still drops 👀 — handleNote already acks with the agent's own token", async () => {
    const gl = new GitLabAdapter(makeConfig(), () => {})

    await gl.react("noqta/minbar:issue:46", "104670", "👀", "coder-agent")

    expect(calls).toHaveLength(0)
  })

  it("ignores malformed chatIds rather than posting to the wrong place", async () => {
    const gl = new GitLabAdapter(makeConfig(), () => {})

    await gl.react("not-a-chat-id", "104670", "❌", "coder-agent")

    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe("cleanMeshError", () => {
  it("peels a single mesh hop down to the real cause", () => {
    expect(cleanMeshError(
      'Peer "macbook-local" /task error: 500: Anthropic\'s API is temporarily overloaded. — AgentX will retry in a moment.',
    )).toBe("Anthropic's API is temporarily overloaded.")
  })

  it("peels a nested fallback chain (the shape seen on noqta/minbar#46)", () => {
    expect(cleanMeshError(
      'Peer "macbook-local" /task error: 500: mesh fallback failed: Peer "clawd-server" /task error: 500: Anthropic\'s API is temporarily overloaded. — AgentX will retry in a moment.',
    )).toBe("Anthropic's API is temporarily overloaded.")
  })

  it("drops the retry promise — nothing actually retries once we post", () => {
    expect(cleanMeshError("Something broke. — AgentX will retry in a moment.")).toBe("Something broke.")
  })

  it("keeps actionable fix clauses", () => {
    const msg = "The agent is out of Anthropic credits. — Top up at https://console.anthropic.com/settings/billing"
    expect(cleanMeshError(msg)).toBe(msg)
  })

  it("leaves an already-clean message alone and tolerates empty input", () => {
    expect(cleanMeshError("Claude Code timed out after 15m.")).toBe("Claude Code timed out after 15m.")
    expect(cleanMeshError("")).toBe("")
  })
})
