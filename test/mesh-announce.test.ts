import { describe, expect, it } from "vitest"
import { TypedEventBus } from "../src/events/bus"
import { recentFeed } from "../src/events/feed-http"
import { publishAnnouncement } from "../src/events/announce"
import { isControlPost } from "../src/daemon/mesh-auth"

describe("mesh announcements", () => {
  it("publishes one local announce event that peers' feeds serve", () => {
    const bus = new TypedEventBus().configure({ node: "node-b" })
    const r = publishAnnouncement(bus, { text: "Maintenance tonight at 22:00", by: "Operator" }, new Set(["helper"]))
    expect(r.ok).toBe(true)
    // What a follower on another node reads from this one.
    const served = recentFeed(bus, new URLSearchParams({ origin: "local", kind: "announce" })).events
    expect(served).toHaveLength(1)
    expect(served[0]).toMatchObject({ node: "node-b", kind: "announce", type: "announce", summary: "Operator: Maintenance tonight at 22:00" })
    expect(served[0].agentId).toBeUndefined()
    expect(served[0].rootId).toBe(served[0].id)
  })

  it("names an agent author as agentId, caps the summary and rejects empty or oversized text", () => {
    const bus = new TypedEventBus().configure({ node: "node-a" })
    const r = publishAnnouncement(bus, { text: "x".repeat(1500), by: "helper" }, new Set(["helper"]))
    expect(r.ok && r.event.agentId).toBe("helper")
    expect(r.ok && r.event.summary.length).toBeLessThanOrEqual(280)
    expect(publishAnnouncement(bus, { text: "  " }, new Set()).ok).toBe(false)
    expect(publishAnnouncement(bus, {}, new Set()).ok).toBe(false)
    expect(publishAnnouncement(bus, { text: "y".repeat(3000) }, new Set()).ok).toBe(false)
  })

  it("is a control POST, so off-box callers need the mesh token", () => {
    expect(isControlPost("/mesh/announce")).toBe(true)
  })
})
