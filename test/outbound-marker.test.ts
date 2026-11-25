import { describe, it, expect } from "vitest"
import {
  markBody,
  detectAgentxMarker,
  stripAgentxMarkers,
  isAgentxOutbound,
} from "../src/channels/outbound-marker"

describe("outbound-marker", () => {
  it("appends the marker to a fresh body", () => {
    const out = markBody("Hello!", "coder-agent")
    expect(out).toContain("Hello!")
    expect(out).toContain("<!-- agentx:coder-agent -->")
  })

  it("is idempotent — does not double-stamp an already-marked body", () => {
    const once = markBody("Hi", "x")
    const twice = markBody(once, "x")
    expect(twice).toBe(once)
  })

  it("detects markers and returns the agentId", () => {
    expect(detectAgentxMarker("body\n\n<!-- agentx:cx-agent -->")).toBe("cx-agent")
    expect(detectAgentxMarker("nope")).toBeNull()
    expect(detectAgentxMarker("")).toBeNull()
    expect(detectAgentxMarker(null)).toBeNull()
  })

  it("strips every marker, even multiples", () => {
    const dirty = "first\n\n<!-- agentx:a -->\nmid\n<!-- agentx:b -->\nend"
    expect(stripAgentxMarkers(dirty)).not.toContain("agentx:")
    expect(stripAgentxMarkers(dirty)).toContain("first")
    expect(stripAgentxMarkers(dirty)).toContain("mid")
    expect(stripAgentxMarkers(dirty)).toContain("end")
  })

  it("isAgentxOutbound is a thin wrapper", () => {
    expect(isAgentxOutbound("body <!-- agentx:x -->")).toBe(true)
    expect(isAgentxOutbound("body")).toBe(false)
  })

  it("handles whitespace + edge formats", () => {
    expect(detectAgentxMarker("body <!--agentx:x-->")).toBe("x")
    expect(detectAgentxMarker("body <!--   agentx:x   -->")).toBe("x")
  })

  it("counts a marker copied with its backticks on a line of its own (#2130)", () => {
    expect(detectAgentxMarker("Fixes the login.\n\n`<!-- agentx:coder -->`")).toBe("coder")
    expect(detectAgentxMarker("Fixes the login.\n  `<!-- agentx:coder -->`  \nmore")).toBe("coder")
  })

  it("still ignores a marker in backticks inside a sentence, a quote or a fence (#2130)", () => {
    expect(detectAgentxMarker("Sign with `<!-- agentx:coder -->` at the end.")).toBeNull()
    expect(detectAgentxMarker("> `<!-- agentx:coder -->`")).toBeNull()
    expect(detectAgentxMarker("```\n`<!-- agentx:coder -->`\n```")).toBeNull()
    expect(detectAgentxMarker("`<!-- agentx:coder --> and more`")).toBeNull()
    // Stripping still leaves nothing detectable.
    expect(detectAgentxMarker(stripAgentxMarkers("body\n`<!-- agentx:coder -->`"))).toBeNull()
  })

  it("agentId can include hyphens, dots, slashes — anything non-whitespace", () => {
    expect(detectAgentxMarker("body <!-- agentx:pm-initech -->")).toBe("pm-initech")
    expect(detectAgentxMarker("body <!-- agentx:devops.acme -->")).toBe("devops.acme")
  })
})
