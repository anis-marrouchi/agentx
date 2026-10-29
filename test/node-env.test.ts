import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { detectOs, parseOsRelease, parseSwVers, type HostInfo, type HostSources } from "../src/native/host-info"
import { parseVersion } from "../src/native/tool-version"
import {
  clearDispatchHistory, liftProviderHolds, liftedProviderHolds, recordRateLimitEvent, recordSessionInit,
} from "../src/agents/claude-code-quota"
import { NodeEnvironment, credentialLabel } from "../src/node-env"
import { formatNode } from "../src/node-env/format"
import { isNodeFact, NODE_FACTS_RULE } from "../src/agents/node-facts"
import { MemoryStore, type MemoryFact } from "../src/agents/memory-store"
import { memoryContextLines, renderMemoryBlock } from "../src/agents/memory-context"
import { routeMemo } from "../src/wiki/facts/fact-proposals"
import { splitMemo } from "../src/agents/fact-freshness"
import { LandscapeBuilder } from "../src/agents/landscape"
import { onDemandContextNote, AGENTX_CORE_TOOLS } from "../src/agents/session-profile"
import type { AdmissionSnapshot } from "../src/admission/queue"

// #1531: the node answers questions about its own environment.

const T0 = Date.parse("2026-10-29T07:00:00Z")

function rateEvent(status: string, window: string, resetsAt?: number) {
  return { type: "rate_limit_event", rate_limit_info: { status, rateLimitType: window, ...(resetsAt && { resetsAt: Math.floor(resetsAt / 1000) }) } }
}

function sources(platform: string, extra: Partial<HostSources> = {}): HostSources {
  return { platform: () => platform, readOsRelease: async () => "", swVers: async () => "", osVersion: () => "", ...extra }
}

describe("host detection", () => {
  it("reads macOS from sw_vers", async () => {
    const os = await detectOs(sources("darwin", { swVers: async () => "ProductName:\t\tmacOS\nProductVersion:\t\t15.1\nBuildVersion:\t\t24B83\n" }))
    expect(os).toMatchObject({ name: "macOS", version: "15.1", build: "24B83", pretty: "macOS 15.1", distro: null })
  })

  it("reads a Linux distro from os-release", async () => {
    const text = 'NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n'
    expect(parseOsRelease(text)).toMatchObject({ NAME: "Ubuntu", VERSION_ID: "24.04", ID: "ubuntu" })
    const os = await detectOs(sources("linux", { readOsRelease: async () => text }))
    expect(os).toMatchObject({ name: "Ubuntu", version: "24.04", distro: "ubuntu", pretty: "Ubuntu 24.04.1 LTS" })
  })

  it("reads Windows from os.version()", async () => {
    const os = await detectOs(sources("win32", { osVersion: () => "Windows 11 Pro" }))
    expect(os).toMatchObject({ name: "Windows 11 Pro", pretty: "Windows 11 Pro" })
  })

  it("falls back to plain names when the sources are empty", async () => {
    expect((await detectOs(sources("linux"))).name).toBe("Linux")
    expect((await detectOs(sources("darwin"))).name).toBe("macOS")
    expect(parseSwVers("")).toEqual({ name: undefined, version: undefined, build: undefined })
  })
})

describe("tool versions", () => {
  it("keeps the first version-looking token", () => {
    expect(parseVersion("2.1.4 (Claude Code)")).toBe("2.1.4")
    expect(parseVersion("git version 2.43.0")).toBe("2.43.0")
    expect(parseVersion("v22.11.0")).toBe("22.11.0")
    expect(parseVersion("gh version 2.62.0 (2024-11-14)")).toBe("2.62.0")
    expect(parseVersion("no version here")).toBeNull()
  })
})

describe("holds lift visibly", () => {
  beforeEach(() => clearDispatchHistory())

  it("a served request lifts the hold and says when", () => {
    recordRateLimitEvent(rateEvent("rejected", "seven_day", T0 + 34 * 3600_000), T0)
    recordRateLimitEvent(rateEvent("allowed", "five_hour"), T0 + 30 * 60_000)
    expect(liftedProviderHolds(T0 + 31 * 60_000)).toEqual([
      expect.objectContaining({ window: "seven_day", how: "served", liftedAt: T0 + 30 * 60_000, heldSince: T0 }),
    ])
  })

  it("the operator's lift and a passed reset time count as lifted", () => {
    recordRateLimitEvent(rateEvent("rejected", "five_hour", T0 + 3600_000), T0)
    expect(liftProviderHolds(T0 + 60_000).map((s) => s.window)).toEqual(["five_hour"])
    expect(liftedProviderHolds(T0 + 120_000)[0]).toMatchObject({ how: "operator" })

    clearDispatchHistory()
    recordRateLimitEvent(rateEvent("rejected", "five_hour", T0 + 3600_000), T0)
    expect(liftedProviderHolds(T0 + 1800_000)).toEqual([])
    expect(liftedProviderHolds(T0 + 2 * 3600_000)[0]).toMatchObject({ how: "reset", liftedAt: T0 + 3600_000 })
  })

  it("a new refusal of the same window drops its lifted entry", () => {
    recordRateLimitEvent(rateEvent("rejected", "five_hour", T0 + 3600_000), T0)
    recordRateLimitEvent(rateEvent("allowed", "five_hour"), T0 + 60_000)
    recordRateLimitEvent(rateEvent("rejected", "five_hour", T0 + 7200_000), T0 + 120_000)
    expect(liftedProviderHolds(T0 + 180_000)).toEqual([])
  })

  it("forgets a lifted hold after a day", () => {
    recordRateLimitEvent(rateEvent("rejected", "five_hour", T0 + 3600_000), T0)
    liftProviderHolds(T0 + 60_000)
    expect(liftedProviderHolds(T0 + 25 * 3600_000)).toEqual([])
  })
})

function snapshot(at: number): AdmissionSnapshot {
  return {
    enabled: true, mode: "enforce", checkedAt: new Date(at).toISOString(),
    resources: { at, memTotalMB: 8192, memAvailableMB: 2048, swapTotalMB: 0, swapUsedMB: 0, swapGrows: false, diskFreeMB: 40_000, load1: 1.2, cpuCount: 8 },
    limits: null, gate: { open: true, reasons: [] },
    caps: { maxSessions: 6, ownerExtraSessions: 1, delegationHeadroom: 2, classes: {} },
    warmUp: { active: false, until: new Date(at).toISOString(), startsPerInterval: 2, intervalSeconds: 30 },
    running: [], waiting: [], next: null,
  }
}

const HOST: HostInfo = {
  checkedAt: new Date(T0).toISOString(), platform: "linux", arch: "x64", hostname: "demo-node",
  os: { name: "Ubuntu", version: "24.04", distro: "ubuntu", build: null, pretty: "Ubuntu 24.04.1 LTS", kernel: "6.8.0" },
  cpu: { model: "Demo CPU", count: 8 }, memTotalMB: 8192,
}

function makeEnv(now: { t: number }, reads: string[]) {
  return new NodeEnvironment({
    config: () => ({
      node: { id: "n1", name: "Demo" } as any,
      agents: { coder: { tier: "claude-code", billing: "subscription" } as any, bot: { tier: "claude-code", billing: "api" } as any },
      environment: { tools: ["git", { name: "claude", command: "claude", args: ["--version"] }, "missing-tool"], toolsRefreshHours: 6 },
    }),
    admission: { refresh: async () => {}, snapshot: () => snapshot(now.t) },
    build: { version: "0.190.0", commit: "abcdef1234", startedAt: new Date(T0).toISOString() },
    now: () => now.t,
    detectHost: async () => HOST,
    readTool: async (cmd) => {
      reads.push(cmd)
      if (cmd === "missing-tool") return { found: false, version: null, raw: null }
      return { found: true, version: cmd === "git" ? "2.43.0" : "2.1.4", raw: "x" }
    },
  })
}

describe("GET /api/node report", () => {
  beforeEach(() => clearDispatchHistory())

  it("carries a check time on every section and reads tools only at start", async () => {
    const now = { t: T0 }
    const reads: string[] = []
    const env = makeEnv(now, reads)
    await env.start()
    env.stop()
    now.t = T0 + 10 * 60_000
    const r = await env.report()
    await env.report()
    expect(reads).toEqual(["git", "claude", "missing-tool"])
    expect(r.checkedAt).toBe(new Date(now.t).toISOString())
    expect(r.host?.checkedAt).toBe(HOST.checkedAt)
    expect(r.host?.live?.checkedAt).toBe(new Date(now.t).toISOString())
    expect(r.tools.checkedAt).toBe(new Date(T0).toISOString())
    expect(r.tools.nextCheckAt).toBe(new Date(T0 + 6 * 3600_000).toISOString())
    expect(r.tools.items.map((t) => [t.name, t.found, t.version])).toEqual([["git", true, "2.43.0"], ["claude", true, "2.1.4"], ["missing-tool", false, null]])
    expect(r.account.billing).toEqual({ subscription: ["coder"], api: ["bot"] })
    expect(r.account.dispatches.checkedAt).toBe(r.checkedAt)
    expect(r.work?.checkedAt).toBe(new Date(now.t).toISOString())
  })

  it("names the account the last Claude Code session ran on", async () => {
    recordSessionInit({ type: "system", subtype: "init", apiKeySource: "none", claude_code_version: "2.1.4", model: "sonnet" }, T0, "coder")
    const now = { t: T0 + 60_000 }
    const r = await makeEnv(now, []).report()
    expect(r.account.lastSession).toEqual({ agentId: "coder", credential: "subscription (claude /login)", cliVersion: "2.1.4", model: "sonnet", checkedAt: new Date(T0).toISOString() })
    expect(credentialLabel("ANTHROPIC_API_KEY")).toBe("API key (ANTHROPIC_API_KEY)")
  })

  it("answers 'is there a usage limit right now?' with the hold, then with its lift", async () => {
    const now = { t: T0 }
    const env = makeEnv(now, [])
    await env.start()
    env.stop()
    recordRateLimitEvent(rateEvent("rejected", "seven_day", T0 + 34 * 3600_000), T0)
    let text = formatNode(await env.report(), now.t)
    expect(text).toMatch(/LIMIT {4}seven day window used up: new sessions are held, resets 2026-10-30T17:00:00.000Z/)

    now.t = T0 + 30 * 60_000
    recordRateLimitEvent(rateEvent("allowed", "five_hour"), now.t)
    const r = await env.report()
    expect(r.account.holds).toEqual([])
    expect(r.account.lifted).toEqual([expect.objectContaining({ window: "seven_day", how: "served", liftedAt: "2026-10-29T07:30:00.000Z" })])
    text = formatNode(r, now.t)
    expect(text).toContain("no usage limit holds work right now (checked 2026-10-29T07:30:00.000Z)")
    expect(text).toContain("seven day hold (since 2026-10-29T07:00:00.000Z) lifted 2026-10-29T07:30:00.000Z")
    expect(text).toContain("Ubuntu 24.04.1 LTS")
    expect(text).toContain("missing-tool not installed")
  })
})

describe("limit notes are the node's, not memory's", () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(resolve(tmpdir(), "agentx-node-")) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const TRIGGER = "Claude weekly limit reached, resets 10-30 17:00"
  // Lasting facts about other systems, and a decision: memory keeps them.
  const OTHER_SYSTEMS = [
    "nginx rate limit on the API vhost is 10r/s per IP",
    "Supabase auth email rate limit is 4/hour on the free plan",
    "Owner decided extra usage stays off for the Max plan",
    "Video vendor wallet auto-reload off; overage billed per second",
    "Password reset window is 60 minutes in the app",
    "GitHub API request limit 5000/h for the PAT",
    "Mail provider daily limit 300 emails on sandbox domain",
    "Vercel deploy quota exceeded on hobby plan",
    "Mailgun quota resets every 7 days",
    "Let's Encrypt rate limit resets after 7 days",
    "Saber cert quota exceeded, retry in 5 hours",
  ]

  it("recognises limit, reset and hold notes, not other uses of the words", () => {
    for (const t of [TRIGGER, "usage limits hit on the shared account", "5-hour limit resets at 14:00", "cold dispatches are held until the reset", "Claude is rate-limited", "plan hold on seven_day", "weekly limit, resets 10-30 17:00", "five_hour window rejected, resets 12:00", "The 5h window resets at 14:00", "seven-day limit reached"]) {
      expect(isNodeFact(t), t).toBe(true)
    }
    for (const t of ["deploy path is /srv/app", "reset the password for the demo user", "the char limit for titles is 80", "Alex prefers short replies", "Uses Claude.\nnginx is rate-limited at 10r/s", ...OTHER_SYSTEMS]) {
      expect(isNodeFact(t), t).toBe(false)
    }
  })

  it("memory refuses to store one", () => {
    const store = new MemoryStore(root)
    const source = { channel: "telegram", chatId: "1", sender: "owner", date: "2026-10-29" }
    expect(store.addMemory("coder", { agentId: "coder", category: "fact", content: TRIGGER, keywords: ["limit"], source })).toBe(false)
    expect(store.addMemory("coder", { agentId: "coder", category: "fact", content: "Alex prefers short replies", keywords: [], source })).toBe(true)
    expect(store.getAll("coder").map((m) => m.content)).toEqual(["Alex prefers short replies"])
  })

  it("memory keeps limit facts about other systems, not marked stale", () => {
    const store = new MemoryStore(root)
    const source = { channel: "telegram", chatId: "1", sender: "owner", date: "2026-10-29" }
    for (const content of OTHER_SYSTEMS) {
      expect(store.addMemory("coder", { agentId: "coder", category: "fact", content, keywords: [], source }), content).toBe(true)
    }
    expect(store.getAll("coder").map((m) => m.content).sort()).toEqual([...OTHER_SYSTEMS].sort())
    const notes: MemoryFact[] = OTHER_SYSTEMS.map((content, i) => ({
      id: `o${i}`, agentId: "coder", category: "fact", content, keywords: [], source,
      createdAt: new Date(T0 - 3600_000).toISOString(),
    }))
    const block = renderMemoryBlock(memoryContextLines(notes, [], T0))
    for (const content of OTHER_SYSTEMS) expect(block, content).toContain(content)
    expect(block).not.toContain("STALE")
  })

  it("a stale note stored earlier is marked and points at agentx_node, even when fresh", () => {
    const note: MemoryFact = {
      id: "a", agentId: "coder", category: "fact", content: TRIGGER, keywords: ["limit"],
      source: { channel: "telegram", chatId: "1", sender: "owner", date: "2026-10-29" },
      createdAt: new Date(T0 - 3600_000).toISOString(),
    }
    const block = renderMemoryBlock(memoryContextLines([note], [], T0))
    expect(block).toContain(`STALE (limits change hourly; check agentx_node) ${TRIGGER}`)
    // and every prompt tells the agent to answer from the tool with its check time
    const landscape = new LandscapeBuilder({
      node: { id: "n1", name: "Node", bind: "127.0.0.1:19900" },
      agents: { coder: { name: "Coder", tier: "claude-code", systemPrompt: "Writes code." } },
      channels: { telegram: { enabled: false }, gitlab: { enabled: false }, whatsapp: { enabled: false } },
    } as any)
    landscape.build()
    expect(landscape.getForAgent("coder")).toContain(NODE_FACTS_RULE)
    expect(landscape.getForAgent("coder")).toContain("http://localhost:19900/api/node?format=text")
    expect(onDemandContextNote("telegram", "1")).toContain("agentx_node: answer from it with its check time, never from memory")
    expect(AGENTX_CORE_TOOLS).toContain("agentx_node")
  })

  it("a session memo drops limit lines instead of keeping or proposing them", () => {
    const memo = `- Drafting the release notes\n- ${TRIGGER}`
    const r = routeMemo(resolve(root, ".agentx/wiki"), memo, { agentId: "coder", origin: "continuity-memo" })
    expect(r.workState).toBe("- Drafting the release notes")
    expect(r.proposals).toEqual([])
    expect(r.pinned).not.toContain("resets 10-30")
    expect(r.pinned).toContain("ask agentx_node")
  })

  it("a session memo keeps limit facts about other systems", () => {
    const memo = OTHER_SYSTEMS.map((t) => `- ${t}`).join("\n")
    expect(splitMemo(memo).nodeFacts).toEqual([])
    const r = routeMemo(resolve(root, ".agentx/wiki"), memo, { agentId: "coder", origin: "continuity-memo" })
    expect(r.pinned).not.toContain("ask agentx_node")
    for (const t of OTHER_SYSTEMS) expect(r.pinned, t).toContain(t)
  })
})
