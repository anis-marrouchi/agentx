import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { openDb, closeDb } from "../src/storage/sqlite"
import { getTrace, listTraces, recordTraceEnd, recordTraceStart, recordTraceStep } from "../src/storage/traces"
import {
  buildDraftsFromClusters,
  buildWorkflowDraftFromTrace,
  clusterWorkflowCandidates,
  inferWorkflowName,
  listWorkflowDrafts,
  loadSuccessfulTraces,
  matchWorkflow,
  promoteWorkflowDraft,
  rejectWorkflowDraft,
  validateWorkflowDraft,
  writeWorkflowDraft,
  workflowSchema,
} from "../src/workflows"

let tmp: string

beforeEach(() => {
  closeDb()
  tmp = mkdtempSync(path.join(tmpdir(), "agentx-workflow-absorb-"))
})

afterEach(() => {
  closeDb()
  rmSync(tmp, { recursive: true, force: true })
})

function openTmpDb() {
  return openDb({ path: path.join(tmp, "db.sqlite") })!
}

describe("workflow generated metadata", () => {
  it("defaults existing workflows to active metadata", () => {
    const wf = workflowSchema.parse({
      id: "plain",
      version: 2,
      title: "Plain",
      nodes: [{ id: "trigger", type: "trigger.manual", config: {} }, { id: "done", type: "end", config: {} }],
      edges: [{ from: "trigger", to: "done" }],
    })
    expect(wf.status).toBe("active")
    expect(wf.tags).toEqual([])
    expect(wf.matchCount).toBe(0)
  })
})

describe("workflow draft generation", () => {
  it("builds a disabled draft workflow from a successful trace", () => {
    const db = openTmpDb()
    const taskId = recordTraceStart(db, {
      agentId: "coder",
      channel: "telegram",
      chatId: "c1",
      messagePreview: "fix telegram formatting",
    })
    recordTraceStep(db, taskId, { name: "tool_use", action: "Edit", status: "ok", inputSummary: "src/channels/telegram.ts" })
    recordTraceEnd(db, taskId, { status: "ok", inputTokens: 10, outputTokens: 3 })

    const trace = getTrace(db, taskId)!
    const wf = buildWorkflowDraftFromTrace(trace.task, trace.steps)

    expect(wf.status).toBe("draft")
    expect(wf.state).toBe("disabled")
    expect(wf.sourceTaskIds).toContain(taskId)
    expect(wf.ownerAgent).toBe("coder")
    expect(validateWorkflowDraft(wf)).toEqual([])
  })

  it("writes, lists, promotes, and rejects drafts", () => {
    const db = openTmpDb()
    const taskId = recordTraceStart(db, { agentId: "ops", messagePreview: "restart service" })
    recordTraceEnd(db, taskId, { status: "ok" })
    const trace = getTrace(db, taskId)!
    const wf = buildWorkflowDraftFromTrace(trace.task, trace.steps, { id: "restart-service-draft" })

    const draftPath = writeWorkflowDraft(wf, { baseDir: tmp })
    expect(draftPath).toContain("_drafts")
    expect(listWorkflowDrafts(tmp).map((d) => d.id)).toEqual(["restart-service-draft"])

    const promoted = promoteWorkflowDraft("restart-service-draft", { baseDir: tmp })
    expect(promoted.workflow.status).toBe("active")
    expect(promoted.workflow.state).toBe("active")
    expect(listWorkflowDrafts(tmp)).toHaveLength(0)

    writeWorkflowDraft(wf, { baseDir: tmp })
    const rejected = rejectWorkflowDraft("restart-service-draft", tmp)
    expect(rejected).toContain("_rejected")
    expect(listWorkflowDrafts(tmp)).toHaveLength(0)
  })

  it("keeps drafts beside a configured workflow directory", () => {
    const db = openTmpDb()
    const workflowsDir = path.join(tmp, "custom-workflows")
    const taskId = recordTraceStart(db, { agentId: "ops", messagePreview: "rotate api key" })
    recordTraceEnd(db, taskId, { status: "ok" })
    const trace = getTrace(db, taskId)!
    const wf = buildWorkflowDraftFromTrace(trace.task, trace.steps, { id: "rotate-api-key-draft" })

    const draftPath = writeWorkflowDraft(wf, { workflowDir: workflowsDir })
    expect(draftPath).toBe(path.join(workflowsDir, "_drafts", "rotate-api-key-draft.yaml"))
    expect(listWorkflowDrafts(tmp, { workflowDir: workflowsDir }).map((d) => d.id)).toEqual(["rotate-api-key-draft"])

    const promoted = promoteWorkflowDraft("rotate-api-key-draft", { workflowDir: workflowsDir })
    expect(promoted.to).toBe(path.join(workflowsDir, "rotate-api-key-draft.yaml"))
    expect(listWorkflowDrafts(tmp, { workflowDir: workflowsDir })).toHaveLength(0)
  })
})

describe("workflow absorb clustering", () => {
  it("infers project and normalized kind from GitHub and GitLab chat ids", () => {
    const gitlabMr = {
      taskId: "trace-gitlab",
      agentId: "coder-agent",
      channel: "gitlab",
      chatId: "noqta/mtgl:merge_request:42",
      messagePreview: "review this merge request",
      status: "ok",
      startedAt: 1,
    } as any
    const githubPr = {
      ...gitlabMr,
      taskId: "trace-github",
      channel: "github",
      chatId: "anis-marrouchi/agentx:pull_request:12",
    }
    const githubPush = {
      ...gitlabMr,
      taskId: "trace-push",
      channel: "github",
      chatId: "anis-marrouchi/agentx:push:refs/heads/master",
      messagePreview: "feat(workflows): add draft management",
    }

    expect(inferWorkflowName(gitlabMr)).toMatchObject({ project: "mtgl", kind: "mr" })
    expect(inferWorkflowName(githubPr)).toMatchObject({ project: "agentx", kind: "mr" })
    expect(inferWorkflowName(githubPush)).toEqual({ project: "agentx", kind: "push" })
  })

  it("clusters structured traces without agent id or commit-message verbs", () => {
    const traces = ["coder-agent", "devops-agent", "coder-agent"].map((agentId, i) => ({
      taskId: `trace-${i}`,
      agentId,
      channel: "github",
      chatId: "anis-marrouchi/agentx:push:refs/heads/master",
      messagePreview: i === 0 ? "feat(workflows): add draft management" : "fix(workflows): respect configured draft directory",
      status: "ok",
      startedAt: i,
    })) as any

    const clusters = clusterWorkflowCandidates(traces, { minClusterSize: 3 })

    expect(clusters).toHaveLength(1)
    expect(clusters[0].key).toBe("agentx:push")
  })

  it("filters short successful traces before absorb clustering", () => {
    const db = openTmpDb()
    recordTraceEnd(db, recordTraceStart(db, { agentId: "coder", messagePreview: "ok" }), { status: "ok" })
    const longTaskId = recordTraceStart(db, { agentId: "coder", messagePreview: "fix github workflow draft naming behavior" })
    recordTraceEnd(db, longTaskId, { status: "ok" })

    const traces = loadSuccessfulTraces(db)

    expect(traces.map((t) => t.taskId)).toEqual([longTaskId])
  })

  it("clusters repeated successful free-form traces and builds drafts", () => {
    const db = openTmpDb()
    for (let i = 0; i < 3; i++) {
      const id = recordTraceStart(db, {
        agentId: "coder",
        channel: "api",
        messagePreview: "fix telegram formatting markdown",
      })
      recordTraceEnd(db, id, { status: "ok" })
    }
    const traces = listTraces(db, { status: "ok" })
    const clusters = clusterWorkflowCandidates(traces, { minClusterSize: 3 })
    expect(clusters).toHaveLength(1)

    const drafts = buildDraftsFromClusters(db, clusters)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].sourceTaskIds).toHaveLength(3)
    expect(validateWorkflowDraft(drafts[0].workflow)).toEqual([])
  })
})

describe("workflow matching", () => {
  it("matches active reusable workflows and ignores drafts", () => {
    const active = workflowSchema.parse({
      id: "telegram-formatting",
      version: 2,
      title: "Fix Telegram formatting",
      status: "active",
      state: "active",
      tags: ["telegram"],
      ownerAgent: "coder",
      nodes: [{ id: "trigger", type: "trigger.manual", config: {} }, { id: "done", type: "end", config: {} }],
      edges: [{ from: "trigger", to: "done" }],
    })
    const draft = workflowSchema.parse({ ...active, id: "telegram-formatting-draft", status: "draft", state: "disabled" })

    const match = matchWorkflow({
      agentId: "coder",
      channel: "telegram",
      message: "please fix the telegram formatting",
    }, [draft, active])

    expect(match?.workflow.id).toBe("telegram-formatting")
    expect(match?.confidence).toBeGreaterThanOrEqual(0.65)
  })
})
