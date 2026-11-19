import { describe, expect, it } from "vitest"
import { isPrivateAddress } from "../src/situations/sources/per-request"
import { SOURCES_READ_MARK, SOURCES_READ_REDACTED } from "../src/situations/sources/redact"

// Follow-up to the #1982 review (#1892 phase 7).
describe("phase 7 follow-up", () => {
  it("treats IPv4 inside IPv6 and 192.0.0.0/24 as private", () => {
    for (const ip of [
      "192.0.0.1", "192.0.0.255",
      "::127.0.0.1", "::7f00:1", "::a00:5", // IPv4-compatible
      "::ffff:7f00:1", "::ffff:127.0.0.1", "0:0:0:0:0:ffff:a00:1", // mapped
      "2002:7f00:1::", "2002:c0a8:101::1", // 6to4 to a private address
      "64:ff9b::7f00:1",
    ]) expect(isPrivateAddress(ip), ip).toBe(true)
    for (const ip of ["192.0.1.1", "2606:2800:220:1:248:1893:25c8:1946", "2a00:1450:4007:80b::200e"])
      expect(isPrivateAddress(ip), ip).toBe(false)
  })

  it("the read mark names only what AgentX itself does not keep", () => {
    for (const mark of [SOURCES_READ_MARK, SOURCES_READ_REDACTED]) expect(mark).not.toMatch(/; not kept\]|content not kept\]/)
    expect(SOURCES_READ_MARK).toMatch(/traces/)
  })
})
