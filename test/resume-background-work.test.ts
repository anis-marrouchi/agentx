import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { closeDb, openDb } from "../src/storage/sqlite"
import { recordTraceStart, recordTraceStep, takeInterruptedRuns, type InterruptedRun } from "../src/storage/traces"
import {
  BACKGROUND_WORK_STEP, backgroundWorkOf, decodeBackgroundWork, describeBackgroundWork,
  encodeBackgroundWork, noteBackgroundWork, workDirsIn, type BackgroundWork,
} from "../src/agents/resume/background"
import { buildResumeNote } from "../src/agents/resume/note"
import { reportedText, ResumeCoordinator } from "../src/agents/resume/coordinator"
import { DEFAULT_RESUME_SETTINGS } from "../src/agents/resume/policy"

let tmp: string
beforeEach(() => { closeDb(); tmp = mkdtempSync(path.join(tmpdir(), "agentx-bgwork-")) })
afterEach(() => { closeDb(); rmSync(tmp, { recursive: true, force: true }) })
const openTmp = () => openDb({ path: path.join(tmp, "db.sqlite") })!

const NOW = Date.parse("2026-10-25T01:00:00.000Z")
const builder: BackgroundWork = { kind: "subagent", tool: "Agent", label: "Lane builder #1182", dirs: ["/tmp/agentx-1182"] }

function run(over: Partial<InterruptedRun> = {}): InterruptedRun {
  return {
    taskId: "t1", agentId: "dev-agent", channel: "cron", chatId: "nightly", workflowRunId: null,
    startedAt: NOW - 5 * 60_000, originalMessage: "build the lanes", resumeOrigin: null, resumeAttempt: 0,
    toolCalls: [], ...over,
  }
}

describe("backgroundWorkOf", () => {
  it("picks up background subagents and shells, not foreground calls", () => {
    expect(backgroundWorkOf("Agent", {
      description: "Lane builder #1182", run_in_background: true,
      prompt: "git clone --depth 1 https://example.com/acme/app.git /tmp/agentx-1182 && cd /tmp/agentx-1182, then fix the bug",
    })).toEqual({ kind: "subagent", tool: "Agent", label: "Lane builder #1182", dirs: ["/tmp/agentx-1182"] })
    expect(backgroundWorkOf("Bash", { command: "cd ~/src/app && pnpm test", run_in_background: true }))
      .toEqual({ kind: "shell", tool: "Bash", label: "cd ~/src/app && pnpm test", dirs: ["~/src/app"] })
    expect(backgroundWorkOf("Bash", { command: "cd /tmp/x && make" })).toBeNull()
    expect(backgroundWorkOf("Agent", { prompt: "look around", run_in_background: false })).toBeNull()
    expect(backgroundWorkOf("Bash", null)).toBeNull()
  })

  it("reads work dirs from cd, git -C, clone and worktree add", () => {
    expect(workDirsIn("git -C /srv/app status")).toEqual(["/srv/app"])
    expect(workDirsIn("git clone -b main git@example.com:a/b.git '/tmp/b-1'")).toEqual(["/tmp/b-1"])
    expect(workDirsIn("git worktree add -b fix-1 /tmp/wt-1 origin/main")).toEqual(["/tmp/wt-1"])
    expect(workDirsIn("Work dir: /tmp/agentx-1190.")).toEqual(["/tmp/agentx-1190"])
    // Relative targets and bare roots say nothing useful after a restart.
    expect(workDirsIn("git clone https://example.com/a.git app; cd app; cd /")).toEqual([])
  })

  it("collects from stream events, bounded", () => {
    const list: BackgroundWork[] = []
    const event = { type: "assistant", message: { content: [
      { type: "text", text: "starting" },
      { type: "tool_use", name: "Bash", input: { command: "sleep 9", run_in_background: true } },
      { type: "tool_use", name: "Read", input: { file_path: "/x" } },
    ] } }
    noteBackgroundWork(list, event)
    noteBackgroundWork(list, { type: "user", message: { content: [] } })
    expect(list.map((j) => j.label)).toEqual(["sleep 9"])
    for (let n = 0; n < 30; n++) noteBackgroundWork(list, event)
    expect(list).toHaveLength(20)
  })

  it("round-trips through the trace, ignoring junk", () => {
    expect(decodeBackgroundWork(encodeBackgroundWork([builder]))).toEqual([builder])
    expect(decodeBackgroundWork("not json")).toEqual([])
    expect(decodeBackgroundWork('[{"nope":1}]')).toEqual([])
    expect(describeBackgroundWork([builder])).toBe('1 background job(s): subagent "Lane builder #1182"; work dirs: /tmp/agentx-1182')
  })
})

describe("after the restart", () => {
  it("takeInterruptedRuns returns the background work saved on the trace", () => {
    const db = openTmp()
    recordTraceStart(db, { agentId: "dev-agent" }, "t1")
    recordTraceStep(db, "t1", { name: BACKGROUND_WORK_STEP, action: "interrupted", inputSummary: encodeBackgroundWork([builder]) })
    recordTraceStart(db, { agentId: "dev-agent" }, "t2")
    const runs = takeInterruptedRuns(db, NOW)
    expect(runs.find((r) => r.taskId === "t1")?.backgroundWork).toEqual([builder])
    expect(runs.find((r) => r.taskId === "t2")?.backgroundWork).toEqual([])
  })

  it("the resume note names the jobs and the work dirs to check", () => {
    const note = buildResumeNote(run({ backgroundWork: [builder] }))
    expect(note).toContain("You had started background work, and the restart stopped it (1):")
    expect(note).toContain("1. subagent (Agent): Lane builder #1182 — in /tmp/agentx-1182")
    expect(note).toContain("Check that work dir first (git status, git log)")
    expect(buildResumeNote(run())).not.toContain("background work")
  })

  it("a report says where the work was left", () => {
    expect(reportedText("too old", run({ backgroundWork: [builder] })))
      .toContain("It had 1 background job(s) going, stopped by the restart; work left in /tmp/agentx-1182.")
    expect(reportedText("too old")).not.toContain("background")
  })

  it("a skipped run with background work still reaches the operator", async () => {
    const db = openTmp()
    recordTraceStart(db, { agentId: "dev-agent", channel: "cron", chatId: "nightly" }, "t1")
    const [taken] = takeInterruptedRuns(db, NOW)
    const notices: string[] = []
    const outcomes = await new ResumeCoordinator().run({
      db, runs: [{ ...taken, backgroundWork: [builder] }], settings: DEFAULT_RESUME_SETTINGS, now: NOW, boots: [NOW],
      notifyOperator: async (t) => { notices.push(t) }, log: () => {},
    })
    expect(outcomes[0].decision).toBe("skipped")
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("work left in /tmp/agentx-1182")
  })
})
