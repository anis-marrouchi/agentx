import { describe, it, expect } from "vitest"
import { planWhatsAppReconnect, type WhatsAppReconnectState } from "../src/channels/whatsapp"

const fresh = (): WhatsAppReconnectState => ({ conflicts: 0, timeouts: 0 })

// #982: a 408 network timeout on a paired session is not a conflict.
describe("planWhatsAppReconnect", () => {
  it("keeps retrying 408s on a paired session, with a capped backoff", () => {
    const state = fresh()
    const delays: number[] = []
    for (let i = 0; i < 12; i++) {
      const plan = planWhatsAppReconnect(state, 408, true)
      expect(plan.kind).toBe("retry")
      if (plan.kind === "retry") {
        delays.push(plan.delayMs)
        expect(plan.message).toContain("network timeout")
        expect(plan.message).not.toMatch(/conflict|another session/i)
      }
    }
    expect(delays.slice(0, 6)).toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000])
    expect(Math.max(...delays)).toBe(300_000)
    expect(state.conflicts).toBe(0)
  })

  it("gives up after five 440s and names the conflict", () => {
    const state = fresh()
    const plans = Array.from({ length: 5 }, () => planWhatsAppReconnect(state, 440, true))
    expect(plans.slice(0, 4).every((p) => p.kind === "retry")).toBe(true)
    const last = plans[4]
    expect(last.kind).toBe("give-up")
    expect(last.message).toContain("conflict")
    expect(last.message).toContain("Another session is active")
  })

  it("counts only the 440s toward the limit when 408s are mixed in", () => {
    const state = fresh()
    const codes: Array<408 | 440> = [440, 408, 440, 408, 408, 440, 408, 440]
    for (const code of codes) {
      expect(planWhatsAppReconnect(state, code, true).kind).toBe("retry")
    }
    expect(state.conflicts).toBe(4)
    expect(planWhatsAppReconnect(state, 408, true).kind).toBe("retry")
    expect(planWhatsAppReconnect(state, 440, true).kind).toBe("give-up")
  })

  it("keeps the limited retry for 408s while pairing (QR not scanned)", () => {
    const state = fresh()
    const plans = Array.from({ length: 5 }, () => planWhatsAppReconnect(state, 408, false))
    expect(plans.slice(0, 4).every((p) => p.kind === "retry")).toBe(true)
    expect(plans[4].kind).toBe("give-up")
    expect(plans[4].message).toContain("not scanned")
  })
})
