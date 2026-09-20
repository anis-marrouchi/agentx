import { describe, it, expect, vi, beforeEach } from "vitest"
import type { Skill } from "../src/agent/skills/types"

// The policy around the skill ranking.
//
// Which skill a model picks is measured by running it; what the code does
// with that pick is what must not drift. Measured on the devops agent's 16
// skills, which is why this seat is worth its call at all:
//
//   "restart the agentx daemon and tail the logs"
//     lexical  daemon-ops .90, mesh-awareness .90, server-management .90
//     judged   daemon-ops 1.00, the other two 0.00
//
//   "write a haiku about the sea"
//     lexical  jev-decide .20, wiki .20  -> both over the .1 inject floor
//     judged   nothing applies, anyRelevant 0.04
//
// The first is a tie the lexical score cannot break; the second is two
// skills it would have injected into a poem.

const hoisted = vi.hoisted(() => ({ askSeat: vi.fn() }))
// Mocked by its path on disk, not by the "@/" alias. vite-tsconfig-paths
// resolves the alias for IMPORTS, but vi.mock registers against the
// specifier it is given — an aliased one silently matches nothing, the
// real askSeat runs, returns null because no seat is configured under
// test, and every assertion then fails as though the policy were wrong.
vi.mock("../src/decisions/seat", () => ({ askSeat: hoisted.askSeat }))

const skill = (name: string, description: string, triggers?: string[]): Skill => ({
  frontmatter: {
    name, description,
    ...(triggers ? { triggers: triggers.map((pattern) => ({ pattern })) } : {}),
  },
  instructions: `# ${name}`,
  source: "local",
})

function seatAnswers(anyRelevant: number, probabilities: Record<string, number>) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0]
  return {
    answers: {
      anyRelevant: { type: "noul", noul: anyRelevant },
      best: { type: "choice", choice, confidence: 0.9, probabilities },
    },
    callId: "test", mode: "active",
  }
}

const SKILLS = [
  skill("daemon-ops", "Operate the agentx daemon", ["daemon", "restart"]),
  skill("server-management", "Manage servers over ssh", ["server", "restart"]),
  skill("gitlab", "Work with GitLab issues and pipelines", ["gitlab"]),
]

describe("pickSkillForTask", () => {
  beforeEach(() => {
    hoisted.askSeat.mockReset()
    vi.resetModules()
  })

  it("refuses to pick anything when the seat says none apply", async () => {
    // The failure that matters is not picking the wrong skill. It is
    // loading one for a task that needed none — the lexical matcher
    // injects anything scoring over 0.1.
    hoisted.askSeat.mockResolvedValue(
      seatAnswers(0.04, { "daemon-ops": 0.6, "server-management": 0.4 }))
    const { pickSkillForTask } = await import("../src/agent/skills/select")

    const pick = await pickSkillForTask(SKILLS, "restart the daemon on the server")
    expect(pick.skill).toBeNull()
    expect(pick.judged).toBe(true)
    expect(pick.reason).toMatch(/nothing on the shortlist/i)
  })

  it("picks the judged winner over the lexical one", async () => {
    hoisted.askSeat.mockResolvedValue(
      seatAnswers(0.98, { "daemon-ops": 1.0, "server-management": 0.0 }))
    const { pickSkillForTask } = await import("../src/agent/skills/select")

    const pick = await pickSkillForTask(SKILLS, "restart the daemon on the server")
    expect(pick.skill?.frontmatter.name).toBe("daemon-ops")
    // Shortlist comes back re-sorted by the judgement, not the lexical score.
    expect(pick.shortlist[0].name).toBe("daemon-ops")
    expect(pick.shortlist[0].p).toBe(1.0)
  })

  it("refuses a skill the shortlist never offered", async () => {
    // A Choice can only return one of its options, but a malformed or
    // repaired answer must not become a skill nobody proposed.
    hoisted.askSeat.mockResolvedValue(seatAnswers(0.9, { "something-else": 1.0 }))
    const { pickSkillForTask } = await import("../src/agent/skills/select")

    const pick = await pickSkillForTask(SKILLS, "restart the daemon on the server")
    expect(pick.skill).toBeNull()
    expect(pick.reason).toMatch(/was not on the shortlist/i)
  })

  it("falls back to the lexical top match when the seat is off", async () => {
    // askSeat returns null when a seat is off or its backend is down. The
    // command still has to answer, and must not present the fallback as a
    // judgement.
    hoisted.askSeat.mockResolvedValue(null)
    const { pickSkillForTask } = await import("../src/agent/skills/select")

    const pick = await pickSkillForTask(SKILLS, "restart the daemon on the server")
    expect(pick.judged).toBe(false)
    expect(pick.skill).not.toBeNull()
    expect(pick.reason).toMatch(/seat off/i)
  })

  it("does not spend a call when nothing matched", async () => {
    const { pickSkillForTask } = await import("../src/agent/skills/select")
    const pick = await pickSkillForTask(SKILLS, "zzzz qqqq")
    expect(pick.skill).toBeNull()
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })

  it("does not spend a call on a single candidate", async () => {
    // A Choice over one option carries no information.
    const { pickSkillForTask } = await import("../src/agent/skills/select")
    const pick = await pickSkillForTask([SKILLS[2]], "a gitlab pipeline failed")
    expect(pick.skill?.frontmatter.name).toBe("gitlab")
    expect(pick.judged).toBe(false)
    expect(hoisted.askSeat).not.toHaveBeenCalled()
  })
})
