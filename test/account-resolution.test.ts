import { describe, it, expect } from "vitest"
import { pickAccountForAgent } from "../src/channels/account-resolution"

// Models the production "Noqta" group config that motivated the fix:
// agent pm-ksi has TWO Telegram accounts bound to it. ksi-v2 is declared
// first in the config, so it was the unconditional "canonical" pick before
// this change.
const accounts = {
  default: { agentBinding: "atlas" },
  "ksi-v2": { agentBinding: "pm-ksi" },
  "pm-ksi": { agentBinding: "pm-ksi" },
  "pm-mtgl": { agentBinding: "pm-mtgl" },
}

describe("pickAccountForAgent", () => {
  it("returns undefined when no account is bound to the agent", () => {
    expect(pickAccountForAgent(accounts, "ghost-agent")).toBeUndefined()
  })

  it("returns the single bound account when the agent has only one", () => {
    expect(pickAccountForAgent(accounts, "atlas")).toBe("default")
    expect(pickAccountForAgent(accounts, "pm-mtgl")).toBe("pm-mtgl")
  })

  it("returns first config-order match for DMs (no groupId)", () => {
    // No groupId → membership lookup is irrelevant; first wins.
    expect(pickAccountForAgent(accounts, "pm-ksi")).toBe("ksi-v2")
  })

  it("falls back to first candidate when no membership lookup is provided", () => {
    expect(pickAccountForAgent(accounts, "pm-ksi", "g1")).toBe("ksi-v2")
  })

  it("prefers an in-group account over a non-member one", () => {
    // Reproduces the 2026-04-29 "Noqta" group bug: only @noqta_pm_ksi_bot
    // (account "pm-ksi") was a member, so the previous logic dropped every
    // message because it expected ksi-v2. The fix should pick "pm-ksi".
    const result = pickAccountForAgent(
      accounts,
      "pm-ksi",
      "noqta-group",
      () => ["default", "pm-ksi", "pm-mtgl"], // no ksi-v2
    )
    expect(result).toBe("pm-ksi")
  })

  it("keeps the canonical account when both bound bots are in the group", () => {
    // Both bound bots are in the group → first config-order match still wins,
    // matching pre-fix behaviour. Keeps replies coming from a stable bot
    // identity instead of flip-flopping with membership churn.
    const result = pickAccountForAgent(
      accounts,
      "pm-ksi",
      "noqta-group",
      () => ["default", "ksi-v2", "pm-ksi"],
    )
    expect(result).toBe("ksi-v2")
  })

  it("falls back to first candidate when neither bound bot is in the group", () => {
    // No bound bots are present — there's nothing the router can deliver via,
    // so just return something deterministic. The dedup site treats this as
    // "drop"; we only need to avoid throwing or returning undefined.
    const result = pickAccountForAgent(
      accounts,
      "pm-ksi",
      "empty-group",
      () => ["pm-mtgl"],
    )
    expect(result).toBe("ksi-v2")
  })

  it("ignores non-bound accounts that happen to be in the group", () => {
    // An unrelated bot (pm-mtgl, bound to pm-mtgl) being a group member must
    // NOT make it eligible for pm-ksi traffic.
    const result = pickAccountForAgent(
      accounts,
      "pm-ksi",
      "g1",
      () => ["pm-mtgl"], // member, but not bound to pm-ksi
    )
    expect(result).toBe("ksi-v2") // falls back to first candidate
  })
})
