import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// A listed person may be denied named tools and skills (#379, after the
// per-agent slice). The default is open; a denial is a hard limit, enforced
// by a per-run PreToolUse hook the daemon judges; it follows the person
// through a delegation and onto a mesh peer that lists the same person.

const run = vi.hoisted(() => ({ tasks: [] as any[], contexts: [] as string[] }))
vi.mock("../src/agents/runtime", async (importOriginal) => {
  const real: any = await importOriginal()
  return { ...real, executeTask: (_agent: any, task: any, _p: any, _d: any, historyContext?: string) => { run.tasks.push(task); run.contexts.push(String(historyContext ?? "")); return Promise.resolve({ content: "ok", duration: 1 }) } }
})

import { AgentRegistry } from "../src/agents/registry"
import { daemonConfigSchema, personSchema } from "../src/daemon/config"
import { getEventBus } from "../src/events/bus"
import { nameMatches, personLimitsOf, type Person } from "../src/people/people"
import { rootInitiatorOf } from "../src/a2a/initiator"
import {
  checkPersonLimitPayload, clearPersonLimits, registerPersonLimits, withPersonLimitHook,
} from "../src/guard/person-limits"
import { setAutonomyHookPort } from "../src/guard/autonomy-enforce"
import { getAttachRegistry } from "../src/attach"
import { MemberStore } from "../src/members/store"
import { personLimitsUnsupported } from "../src/guard/person-limits"

const sara: Person = { id: "sara", name: "Sara B", role: "member", identities: ["telegram:4242"], deny: { tools: ["Bash", "mcp__mail__*"], skills: ["deploy"] } }
const omar: Person = { id: "omar", name: "Omar K", role: "member", identities: ["telegram:7"] }
const boss: Person = { id: "boss", name: "Boss", role: "owner", identities: ["telegram:1"], deny: { tools: ["Bash"] } }
const fromSara = { channel: "telegram", chatId: "c1", sender: "Sara", senderId: "4242" }

describe("the setting", () => {
  it("is open by default: no deny lists", () => {
    const p = personSchema.parse({ id: "sara", name: "Sara" })
    expect(p.deny).toEqual({ tools: [], skills: [] })
  })

  it("takes tool and skill names, with * as a wildcard", () => {
    const p = personSchema.parse({ id: "sara", name: "Sara", deny: { tools: ["Bash", "mcp__mail__*"], skills: ["deploy"] } })
    expect(p.deny).toEqual({ tools: ["Bash", "mcp__mail__*"], skills: ["deploy"] })
    expect(personSchema.safeParse({ id: "sara", name: "Sara", deny: { tools: [""] } }).success).toBe(false)
    // An unknown level is a typo, not a silent no-op.
    expect(personSchema.safeParse({ id: "sara", name: "Sara", deny: { tool: ["Bash"] } }).success).toBe(false)
  })

  it("is set with `agentx people deny <id> <tools|skills> ...`", async () => {
    const { denyLevel } = await import("../src/commands/people")
    expect(denyLevel("tools")).toBe("tools")
    expect(denyLevel("Skill")).toBe("skills")
    expect(denyLevel("agents")).toBeNull()
  })

  it("matches names without case, and * anywhere", () => {
    expect(nameMatches("Bash", "bash")).toBe(true)
    expect(nameMatches("mcp__mail__*", "mcp__mail__send")).toBe(true)
    expect(nameMatches("mcp__mail__*", "mcp__gitlab__note")).toBe(false)
    expect(nameMatches("Web*", "WebFetch")).toBe(true)
    expect(nameMatches("Bash", "BashOutput")).toBe(false)
  })
})

describe("who is limited", () => {
  it("limits only a listed person with a deny list", () => {
    expect(personLimitsOf([sara, omar], fromSara)).toEqual({ personId: "sara", name: "Sara B", tools: ["Bash", "mcp__mail__*"], skills: ["deploy"] })
    expect(personLimitsOf([sara, omar], { channel: "telegram", chatId: "c2", senderId: "7" })).toBeNull()
    // An unknown sender and a software turn are not limited here.
    expect(personLimitsOf([sara], { channel: "telegram", chatId: "c3", senderId: "999" })).toBeNull()
    expect(personLimitsOf([sara], undefined)).toBeNull()
  })

  it("never limits an owner", () => {
    expect(personLimitsOf([boss], { channel: "telegram", chatId: "c1", senderId: "1" })).toBeNull()
  })

  it("follows the person through a delegation and onto a peer that lists them", () => {
    const root = rootInitiatorOf({ ...fromSara, person: "sara" }, "coder")
    const hop = JSON.parse(JSON.stringify({ channel: "a2a", sender: "agent:coder", initiator: root }))
    expect(personLimitsOf([sara], hop)?.personId).toBe("sara")
    // A peer that does not list the person has nobody to limit.
    expect(personLimitsOf([omar], hop)).toBeNull()
  })
})

describe("the hook", () => {
  afterEach(() => clearPersonLimits("t1"))
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    checkPersonLimitPayload({ tool_name: tool, tool_input: input } as any, { root: tmpdir(), taskId: "t1", agentId: "coder" })

  it("denies a denied tool with a short note, and allows the rest", () => {
    registerPersonLimits("t1", { personId: "sara", name: "Sara B", tools: ["Bash", "mcp__mail__*"], skills: ["deploy"] })
    const bash = call("Bash", { command: "ls" })
    expect(bash.blocked?.tool).toBe("Bash")
    expect(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
    expect(JSON.parse(bash.stdout).hookSpecificOutput.permissionDecisionReason).toContain("Sara B may not use Bash")
    expect(call("mcp__mail__send").blocked).not.toBeNull()
    expect(call("Read", { file_path: "/x" })).toEqual({ stdout: "", blocked: null })
  })

  it("denies a denied skill through the Skill tool", () => {
    registerPersonLimits("t1", { personId: "sara", name: "Sara B", tools: [], skills: ["deploy"] })
    const r = call("Skill", { skill: "deploy" })
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toContain("skill deploy")
    expect(call("Skill", { skill: "review" }).blocked).toBeNull()
  })

  it("refuses a tier that cannot carry the hook rather than run without it", () => {
    expect(personLimitsUnsupported("claude-code")).toBeNull()
    expect(personLimitsUnsupported("codex-cli")).toContain("refusing to run without them")
  })

  it("fails closed for a run it has no limits for", () => {
    const r = call("Read")
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny")
  })

  it("joins the autonomy hook in one --settings, or adds its own", () => {
    setAutonomyHookPort(19999)
    const alone = withPersonLimitHook([], "t1")
    expect("args" in alone).toBe(true)
    const args = (alone as { args: string[] }).args
    const settings = JSON.parse(args[args.indexOf("--settings") + 1])
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("person=1")
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("task=t1")
    const both = withPersonLimitHook(["--disallowedTools", "Write", "--settings", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "auto" }] }] } })], "t1") as { args: string[] }
    expect(both.args.filter((a) => a === "--settings")).toHaveLength(1)
    expect(JSON.parse(both.args[both.args.indexOf("--settings") + 1]).hooks.PreToolUse).toHaveLength(2)
    setAutonomyHookPort(null)
    expect("error" in withPersonLimitHook([], "t1")).toBe(true)
  })
})

describe("through the registry", () => {
  let dir: string
  let registry: AgentRegistry
  const prevCwd = process.cwd()
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentx-limits-"))
    process.chdir(dir)
    getEventBus().removeAllListeners()
    run.tasks = []
    run.contexts = []
    registry = new AgentRegistry(daemonConfigSchema.parse({
      node: { id: "test", name: "test" },
      people: [sara, omar],
      agents: { coder: { name: "Coder", tier: "claude-code", workspace: dir } },
    }), () => {})
  })
  afterEach(() => { process.chdir(prevCwd); rmSync(dir, { recursive: true, force: true }) })

  it("hands a limited person's run its limits, and nobody else's", async () => {
    await registry.execute({ agentId: "coder", message: "fix it", context: { ...fromSara } })
    await registry.execute({ agentId: "coder", message: "fix it", context: { channel: "telegram", chatId: "c2", sender: "Omar", senderId: "7" } })
    expect(run.tasks[0].personLimits).toEqual({ personId: "sara", name: "Sara B", tools: ["Bash", "mcp__mail__*"], skills: ["deploy"] })
    expect(run.tasks[1].personLimits).toBeUndefined()
  }, 15_000)

  it("keeps a limited run off an attached session, which runs outside the hook", async () => {
    const offer = vi.spyOn(getAttachRegistry(), "offer").mockReturnValue(Promise.resolve({ kind: "answered", text: "done", sessionId: "s1" }) as any)
    try {
      const r = await registry.execute({ agentId: "coder", message: "fix it", context: { ...fromSara } })
      expect(offer).not.toHaveBeenCalled()
      expect(r.content).toBe("ok")
    } finally { offer.mockRestore() }
  })

  it("does not inject a denied skill into the prompt", async () => {
    for (const name of ["deploy", "review"]) {
      mkdirSync(join(dir, ".claude", "skills", name), { recursive: true })
      writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} things\nautoInject: true\ntriggers:\n  - pattern: ${name}\n---\nUse ${name} carefully.\n`)
    }
    await registry.execute({ agentId: "coder", message: "deploy and review it", context: { ...fromSara } })
    const prompt = run.contexts[0] + String(run.tasks[0].systemPromptAppend ?? "") + String(run.tasks[0].message ?? "")
    expect(prompt).not.toContain("Use deploy carefully")
    // Proves the injection path ran: the skill she may use is there.
    expect(prompt).toContain("Use review carefully")
  })

  it("keeps a blocked call in the person's trail", () => {
    registry.logToolRefusal("sara", "coder", "Bash")
    registry.logToolRefusal("sara", "coder", "skill:deploy")
    const events = new MemberStore(dir).events("sara").map((e) => [e.event, e.detail])
    expect(events).toEqual(expect.arrayContaining([["tool-refused", "Bash"], ["tool-refused", "skill:deploy"]]))
  })

  it("refuses to forward a limited run to a peer that would get no limits", async () => {
    const sendTask = vi.fn(async () => "answer")
    registry.setMeshFallback({
      findPeerWithSkill: () => undefined,
      sendTask,
      directory: () => [{ peer: "peer-b", healthy: true, skills: [{ id: "atlas" }] }],
    })
    const refused = await registry.execute({ agentId: "atlas", message: "hello", context: { ...fromSara } })
    expect(sendTask).not.toHaveBeenCalled()
    expect(refused.error).toContain("cannot be enforced")
    const ok = await registry.execute({ agentId: "atlas", message: "hello", context: { channel: "telegram", chatId: "c2", sender: "Omar", senderId: "7" } })
    expect(ok.content).toBe("answer")
  })
})
