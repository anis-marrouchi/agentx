import { describe, it, expect } from "vitest"
import { workRequired } from "../src/requests/daemon-api.js"

describe("every request has a kind of work (Anis 2026-11-25)", () => {
  it("names the action and lists the usual kinds", () => {
    expect(workRequired("done")).toMatch(/^done needs `work`/)
    expect(workRequired("accept")).toMatch(/code, ops, review, research, writing or reply/)
  })
})
