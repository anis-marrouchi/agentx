import { describe, it, expect } from "vitest"
import { askOf, headlineOf, isSystemMessage, MARKERS } from "../src/jobs/headline"
import { JOB_STATE_ASK, JOB_STATE_RULE } from "../src/agents/run-state"
import { NOTICE_MARKER } from "../src/agents/notices"
import { SAME_WORK_MARKER } from "../src/agents/work-lane"
import { SAME_HOME_MARKER } from "../src/a2a/home"
import { DELEGATION_RESULT_MARKER } from "../src/a2a/delegation"

describe("what a job is called, and what is not a job (#2555)", () => {
  it("keeps its markers in step with the modules that write them", () => {
    expect(MARKERS.notices).toBe(NOTICE_MARKER)
    expect(MARKERS.sameWork).toBe(SAME_WORK_MARKER)
    expect(MARKERS.sameHome).toBe(SAME_HOME_MARKER)
    expect(MARKERS.delegationResult).toBe(DELEGATION_RESULT_MARKER)
  })

  it("takes the daemon's lines off the ask", () => {
    const notices = "[agentx:notices count=1]\nFor your information; these did not need a run of their own.\n- 2 min ago, from pm: hi\n\n"
    expect(askOf(JOB_STATE_RULE + "Fix the login page")).toBe("Fix the login page")
    expect(askOf(notices + JOB_STATE_RULE + "Fix the login page")).toBe("Fix the login page")
    expect(askOf(notices + "Fix the login page")).toBe("Fix the login page")
    expect(askOf("[agentx:same-home] Another run of yours is already working on a#1.\n" + JOB_STATE_RULE + "Fix it")).toBe("Fix it")
    const sameWork = "[agentx:same-work key=a#1]\nAnother run of yours worked on a#1. It answered:\ndone\n\nThe new message:\n\nNow deploy it"
    expect(askOf(sameWork)).toBe("Now deploy it")
  })

  it("finds no ask in the daemon's own messages", () => {
    expect(isSystemMessage(JOB_STATE_RULE + "[agentx:delegation-result task=dlg-1 from=devops status=waiting]\nEarlier you asked devops…")).toBe(true)
    expect(isSystemMessage("[agentx:job-wake id=job-1] The daemon started this run to continue a job you left open.")).toBe(true)
    expect(isSystemMessage(JOB_STATE_ASK)).toBe(true)
    expect(isSystemMessage("[agentx:notices count=2]\nFor your information.\n- a\n- b\n\n" + JOB_STATE_RULE)).toBe(true)
    expect(isSystemMessage("")).toBe(true)
    expect(isSystemMessage("Fix the login page")).toBe(false)
  })

  it("uses the sender's headline, else the subject of an About opener, never the start of the text", () => {
    expect(headlineOf("  Fix the Jobs page titles ", "anything")).toBe("Fix the Jobs page titles")
    expect(headlineOf(null, "About the Mac disk alert: COO checked at 08:39Z and found 2 GiB free.")).toBe("The Mac disk alert")
    expect(headlineOf(null, "Hakim here. Please fix the login page and deploy it.")).toBeNull()
    expect(headlineOf(null, "About " + "a very long subject ".repeat(8) + ": text")).toBeNull()
    expect(headlineOf("x".repeat(200), "")!.length).toBeLessThanOrEqual(80)
  })
})
