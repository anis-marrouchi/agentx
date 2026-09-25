import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync, rmSync } from "fs"
import { resolve } from "path"
import { RunStore, WorkflowStore, WorkflowDispatcher, workflowSchema, type AgentExecuteRequest } from "../src/workflows"
import { parseYamlWorkflow } from "../src/workflows/yaml"

// The example workflow walked on the real engine; only the sweep script's
// output and the agent are stubbed.
const sweep = vi.hoisted(() => ({ output: "" }))
vi.mock("../src/actions/store", () => ({
  ActionStore: class { get(id: string) { return { id, kind: "shell", command: "true" } } },
}))
vi.mock("../src/actions/runner", () => ({
  runAction: async () => ({ ok: true, output: sweep.output, status: 0, durationMs: 1 }),
}))

const TEST_DIR = resolve(__dirname, "../.test-owner-sweep-workflow")
afterEach(() => rmSync(TEST_DIR, { recursive: true, force: true }))

async function runOnce(output: string) {
  sweep.output = output
  const store = new WorkflowStore({ baseDir: TEST_DIR })
  const text = readFileSync(resolve(__dirname, "../examples/workflows/github-owner-sweep.yaml"), "utf-8")
  store.save(workflowSchema.parse(parseYamlWorkflow(text)))
  const runs = new RunStore({ baseDir: TEST_DIR, nodeId: "node-a" })
  const prompts: AgentExecuteRequest[] = []
  const agents = {
    execute: async (req: AgentExecuteRequest) => { prompts.push(req); return { content: "done", taskId: "t", durationMs: 1 } },
  }
  const dispatcher = new WorkflowDispatcher({ store, runs, nodeId: "node-a", channels: {}, agents })
  await dispatcher.dispatchWorkflow({
    workflowId: "github-owner-sweep",
    trigger: { source: "cron" },
    entityRef: { backend: "cron", id: "github-owner-sweep@t" },
    event: { id: "cron:1", payload: {} },
  })
  await new Promise((r) => setTimeout(r, 50))
  const [run] = runs.list({ workflowId: "github-owner-sweep" })
  return { run, prompts }
}

describe("github-owner-sweep workflow on the engine", () => {
  it("hands new steps to the coordinator agent", async () => {
    const line = '- coder-agent fix-ci pr #52 "clicky": CI red https://github.com/anis-marrouchi/agentx/pull/52'
    const { run, prompts } = await runOnce(`RESULT steps=1\n${line}`)
    expect(run.status).toBe("completed")
    expect(run.history.map((h) => h.nodeId)).toEqual(["sweep", "route", "act", "done"])
    expect(prompts).toHaveLength(1)
    expect(prompts[0].agentId).toBe("secretary-agent")
    expect(prompts[0].message).toContain(line)
  })

  it("does not wake an agent when there is nothing new", async () => {
    const { run, prompts } = await runOnce("RESULT steps=0")
    expect(run.history.map((h) => h.nodeId)).toEqual(["sweep", "route", "done"])
    expect(prompts).toHaveLength(0)
  })
})
