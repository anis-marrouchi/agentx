import { describe, it, expect } from "vitest"
import { pickAccountForAgent } from "../src/channels/account-resolution"

// Models the production "Acme" group config that motivated the fix:
// agent pm-initech has TWO Telegram accounts bound to it. initech-v2 is declared
// first in the config, so it was the unconditional "canonical" pick before
// this change.
const accounts = {
  default: { agentBinding: "atlas" },
  "initech-v2": { agentBinding: "pm-initech" },
  "pm-initech": { agentBinding: "pm-initech" },
  "pm-globex": { agentBinding: "pm-globex" },
}

describe("pickAccountForAgent", () => {
  it("returns undefined when no account is bound to the agent", () => {
    expect(pickAccountForAgent(accounts, "ghost-agent")).toBeUndefined()
  })

  it("returns the single bound account when the agent has only one", () => {
    expect(pickAccountForAgent(accounts, "atlas")).toBe("default")
    expect(pickAccountForAgent(accounts, "pm-globex")).toBe("pm-globex")
  })

  it("returns first config-order match for DMs (no groupId)", () => {
    // No groupId → membership lookup is irrelevant; first wins.
    expect(pickAccountForAgent(accounts, "pm-initech")).toBe("initech-v2")
  })

  it("falls back to first candidate when no membership lookup is provided", () => {
    expect(pickAccountForAgent(accounts, "pm-initech", "g1")).toBe("initech-v2")
  })

  it("prefers an in-group account over a non-member one", () => {
    // Reproduces the 2026-04-29 "Acme" group bug: only @acme_pm_initech_bot
    // (account "pm-initech") was a member, so the previous logic dropped every
    // message because it expected initech-v2. The fix should pick "pm-initech".
    const result = pickAccountForAgent(
      accounts,
      "pm-initech",
      "acme-group",
      () => ["default", "pm-initech", "pm-globex"], // no initech-v2
    )
    expect(result).toBe("pm-initech")
  })

  it("keeps the canonical account when both bound bots are in the group", () => {
    // Both bound bots are in the group → first config-order match still wins,
    // matching pre-fix behaviour. Keeps replies coming from a stable bot
    // identity instead of flip-flopping with membership churn.
    const result = pickAccountForAgent(
      accounts,
      "pm-initech",
      "acme-group",
      () => ["default", "initech-v2", "pm-initech"],
    )
    expect(result).toBe("initech-v2")
  })

  it("falls back to first candidate when neither bound bot is in the group", () => {
    // No bound bots are present — there's nothing the router can deliver via,
    // so just return something deterministic. The dedup site treats this as
    // "drop"; we only need to avoid throwing or returning undefined.
    const result = pickAccountForAgent(
      accounts,
      "pm-initech",
      "empty-group",
      () => ["pm-globex"],
    )
    expect(result).toBe("initech-v2")
  })

  it("ignores non-bound accounts that happen to be in the group", () => {
    // An unrelated bot (pm-globex, bound to pm-globex) being a group member must
    // NOT make it eligible for pm-initech traffic.
    const result = pickAccountForAgent(
      accounts,
      "pm-initech",
      "g1",
      () => ["pm-globex"], // member, but not bound to pm-initech
    )
    expect(result).toBe("initech-v2") // falls back to first candidate
  })
})
