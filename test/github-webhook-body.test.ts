import { describe, it, expect } from "vitest"
import { parseWebhookBody } from "../src/channels/github"
import { detectAgentxMarker } from "../src/channels/outbound-marker"

// A form-encoded webhook turns spaces into "+". Decoded with
// decodeURIComponent they stayed "+", the self-reply marker never matched,
// and the agent answered its own comments in a loop.

const comment = { comment: { body: "PR #168 stays as it is.\n\n<!-- agentx:coder-agent -->" } }

describe("parseWebhookBody", () => {
  it("decodes a form-encoded payload, spaces included, so the marker matches", () => {
    const body = new URLSearchParams({ payload: JSON.stringify(comment) }).toString()
    expect(body).toContain("+")
    const parsed = parseWebhookBody(body, "application/x-www-form-urlencoded") as typeof comment
    expect(parsed.comment.body).toBe(comment.comment.body)
    expect(detectAgentxMarker(parsed.comment.body)).toBe("coder-agent")
  })

  it("keeps a literal plus sent as %2B", () => {
    const body = new URLSearchParams({ payload: JSON.stringify({ text: "1+1 = 2" }) }).toString()
    expect(parseWebhookBody(body, "application/x-www-form-urlencoded")).toEqual({ text: "1+1 = 2" })
  })

  it("reads JSON bodies, and gives {} for anything unreadable", () => {
    expect(parseWebhookBody(JSON.stringify(comment), "application/json")).toEqual(comment)
    expect(parseWebhookBody("", "application/json")).toEqual({})
    expect(parseWebhookBody("not json", "application/json")).toEqual({})
    expect(parseWebhookBody("other=1", "application/x-www-form-urlencoded")).toEqual({})
  })
})
