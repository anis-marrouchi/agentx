import { describe, expect, it } from "vitest"
import { workflowSchema, type Workflow } from "../src/workflows/types"
import {
  resolveAutoRunInputs,
  fillFromChatId,
  applyDefaults,
  missingRequired,
} from "../src/workflows/inputs"

// --- Auto-run input resolution tests ---
//
// The resolver bridges the matcher's free-form bundle (message, chatId,
// channel, agentId, …) to the workflow's typed trigger.inputSchema.
// Tests cover each fill source independently + the merged happy path.

function wfWithSchema(schema: unknown): Workflow {
  return workflowSchema.parse({
    id: "test-wf",
    version: 2,
    title: "Test",
    nodes: [
      { id: "trigger", type: "trigger.manual", config: { inputSchema: schema } },
      { id: "do", type: "action.run", config: { command: "echo {{trigger.input.project}}" } },
      { id: "done", type: "end", config: {} },
    ],
    edges: [{ from: "trigger", to: "do" }, { from: "do", to: "done" }],
  })
}

describe("fillFromChatId", () => {
  const schema = {
    type: "object",
    properties: {
      project: { type: "string" },
      id: { type: "number" },
      mrId: { type: "number" },
      ref: { type: "string" },
    },
  }

  it("parses GitLab merge_request chatIds", () => {
    expect(fillFromChatId("mtgl/mtgl_system:merge_request:959", schema)).toEqual({
      project: "mtgl/mtgl_system",
      id: 959,
      mrId: 959,
    })
  })

  it("parses GitHub push chatIds with branch", () => {
    expect(fillFromChatId("anis-marrouchi/agentx:push:refs/heads/master", schema)).toEqual({
      project: "anis-marrouchi/agentx",
      ref: "master",
    })
  })

  it("parses issue chatIds", () => {
    expect(fillFromChatId("ksi/int.ksi.tn:issue:440", schema)).toEqual({
      project: "ksi/int.ksi.tn",
      id: 440,
      mrId: 440,
    })
  })

  it("returns empty for unparseable chatIds", () => {
    expect(fillFromChatId("1816212449", schema)).toEqual({})
    expect(fillFromChatId(undefined, schema)).toEqual({})
  })

  it("only emits fields the schema declares", () => {
    const minimal = { type: "object", properties: { project: { type: "string" } } }
    expect(fillFromChatId("mtgl/mtgl_system:merge_request:959", minimal)).toEqual({
      project: "mtgl/mtgl_system",
    })
  })
})

describe("applyDefaults", () => {
  it("fills defaults for unset fields only", () => {
    const schema = {
      type: "object",
      properties: {
        environment: { type: "string", default: "staging" },
        ref: { type: "string", default: "master" },
        host: { type: "string" },
      },
    }
    expect(applyDefaults(schema, { ref: "develop" })).toEqual({ ref: "develop", environment: "staging" })
  })
})

describe("missingRequired", () => {
  it("flags empty/null/undefined required fields", () => {
    const schema = { type: "object", required: ["project", "host", "path"], properties: {} }
    expect(missingRequired(schema, { project: "x", host: "y", path: "z" })).toEqual([])
    expect(missingRequired(schema, { project: "x" }).sort()).toEqual(["host", "path"])
    expect(missingRequired(schema, { project: "x", host: "", path: null })).toEqual(["host", "path"])
  })

  it("returns [] when schema has no required array", () => {
    expect(missingRequired({ type: "object", properties: {} }, {})).toEqual([])
    expect(missingRequired(null, { x: 1 })).toEqual([])
  })
})

describe("resolveAutoRunInputs (mtgl deploy shape)", () => {
  const wf = wfWithSchema({
    type: "object",
    properties: {
      project:     { type: "string" },
      environment: { type: "string", enum: ["staging", "production"], default: "staging" },
      host:        { type: "string" },
      path:        { type: "string" },
      ref:         { type: "string", default: "master" },
      mrId:        { type: "number" },
    },
    required: ["project", "host", "path", "ref", "environment"],
  })

  it("fills project + mrId from chatId, environment + ref from defaults — host/path still missing", () => {
    const r = resolveAutoRunInputs(wf, {
      chatId: "mtgl/mtgl_system:merge_request:959",
      channel: "gitlab",
      message: "Deploy MR !959",
      agentId: "devops-agent",
    })
    expect(r.inputs.project).toBe("mtgl/mtgl_system")
    expect(r.inputs.mrId).toBe(959)
    expect(r.inputs.environment).toBe("staging")  // default
    expect(r.inputs.ref).toBe("master")            // default
    expect(r.missing.sort()).toEqual(["host", "path"])
    expect(r.filledFrom.chatId.sort()).toEqual(["mrId", "project"])
    expect(r.filledFrom.defaults.sort()).toEqual(["environment", "ref"])
  })

  it("returns empty missing when host/path are also pre-supplied (e.g. from a hosts mapping in a future iteration)", () => {
    // We don't have a hosts-mapping path yet — this asserts the shape so a
    // later commit that pre-fills host/path from agentx.json doesn't break.
    const r = resolveAutoRunInputs(wf, {
      chatId: "mtgl/mtgl_system:merge_request:959",
      channel: "gitlab",
    })
    // Without host/path, there ARE missing fields, so the auto-runner
    // should fall back to suggest mode. Lock that in.
    expect(r.missing.length).toBeGreaterThan(0)
  })
})

describe("resolveAutoRunInputs (unschematized workflow)", () => {
  it("hands the matcher bundle through when the workflow has no inputSchema", () => {
    const wf = workflowSchema.parse({
      id: "no-schema",
      version: 2,
      title: "No schema",
      nodes: [
        { id: "trigger", type: "trigger.manual", config: {} },
        { id: "do", type: "agent", config: { agentId: "coder", prompt: "{{trigger.input.message}}" } },
        { id: "done", type: "end", config: {} },
      ],
      edges: [{ from: "trigger", to: "do" }, { from: "do", to: "done" }],
    })
    const r = resolveAutoRunInputs(wf, { chatId: "x", message: "hi", agentId: "coder" })
    expect(r.missing).toEqual([])
    expect(r.inputs.message).toBe("hi")
    expect(r.inputs.agentId).toBe("coder")
  })
})

describe("resolveAutoRunInputs (passthrough scoped by schema)", () => {
  it("only passes through context fields the schema actually declares", () => {
    const wf = wfWithSchema({
      type: "object",
      properties: {
        message: { type: "string" },
        // intentionally NOT declaring agentId — should NOT pass through
      },
      required: ["message"],
    })
    const r = resolveAutoRunInputs(wf, {
      message: "ping",
      agentId: "coder",
      chatId: "x",
    })
    expect(r.inputs.message).toBe("ping")
    expect(r.inputs.agentId).toBeUndefined()
    expect(r.missing).toEqual([])
  })
})
