import { describe, it, expect, beforeEach } from "vitest"
import { loadPlugins } from "../src/plugins/loader"
import { getEventBus } from "../src/events/bus"
import type { DaemonConfig, AgentDef } from "../src/daemon/config"
import type { AgentXPlugin } from "../src/plugins/types"
import echoFixture, { inspect } from "./__fixtures__/plugins/echo-channel/index"

function fakeConfig(plugins: string[] = []): DaemonConfig {
  // Loader only reads `config.plugins` and passes the whole config into the
  // context (where it's read-only). A minimally-typed object is fine.
  return { plugins } as unknown as DaemonConfig
}

const noopAgents = new Map<string, AgentDef>()
const captureLog = (sink: string[]) => (...args: unknown[]) => sink.push(args.map(String).join(" "))

beforeEach(() => {
  getEventBus().removeAllListeners()
  inspect.reset()
})

describe("loadPlugins", () => {
  it("returns [] when config.plugins is empty", async () => {
    const out = await loadPlugins({
      config: fakeConfig([]),
      agents: noopAgents,
      log: () => {},
    })
    expect(out).toEqual([])
  })

  it("logs and skips when import throws", async () => {
    const logs: string[] = []
    const out = await loadPlugins({
      config: fakeConfig(["nonexistent-pkg"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: () => Promise.reject(new Error("Module not found")),
    })
    expect(out).toEqual([])
    expect(logs.some((l) => l.includes("nonexistent-pkg") && l.includes("import failed"))).toBe(true)
  })

  it("logs and skips when manifest is missing", async () => {
    const logs: string[] = []
    const bogus = { default: { setup: () => {} } } // no manifest
    const out = await loadPlugins({
      config: fakeConfig(["bogus"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: async () => bogus,
    })
    expect(out).toEqual([])
    expect(logs.some((l) => l.includes("bogus") && l.includes("default AgentXPlugin"))).toBe(true)
  })

  it("logs and skips when manifest fails Zod validation", async () => {
    const logs: string[] = []
    const bad: AgentXPlugin = {
      manifest: { name: "", version: "1.0.0" }, // empty name
      setup: () => {},
    }
    const out = await loadPlugins({
      config: fakeConfig(["bad"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: async () => ({ default: bad }),
    })
    expect(out).toEqual([])
    expect(logs.some((l) => l.includes("manifest invalid"))).toBe(true)
  })

  it("skips when agentxRange does not match daemon major.minor", async () => {
    const logs: string[] = []
    const p: AgentXPlugin = {
      manifest: { name: "p", version: "1.0.0", agentxRange: "0.17" },
      setup: () => {},
    }
    const out = await loadPlugins({
      config: fakeConfig(["p"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: async () => ({ default: p }),
      daemonVersion: "0.18.0",
    })
    expect(out).toEqual([])
    expect(logs.some((l) => l.includes("requires agentx 0.17"))).toBe(true)
  })

  it("loads when agentxRange matches daemon major.minor", async () => {
    const p: AgentXPlugin = {
      manifest: { name: "p", version: "1.0.0", agentxRange: "0.18" },
      setup: () => {},
    }
    const out = await loadPlugins({
      config: fakeConfig(["p"]),
      agents: noopAgents,
      log: () => {},
      importer: async () => ({ default: p }),
      daemonVersion: "0.18.0",
    })
    expect(out).toHaveLength(1)
  })

  it("loads the echo fixture and captures its registered channel", async () => {
    const out = await loadPlugins({
      config: fakeConfig(["agentx-plugin-echo-channel"]),
      agents: noopAgents,
      log: () => {},
      importer: async () => ({ default: echoFixture }),
    })
    expect(out).toHaveLength(1)
    expect(out[0].manifest.name).toBe("echo-channel")
    expect(out[0].channels.map((c) => c.name)).toEqual(["echo"])
    expect(inspect.capturedCtx).toBeDefined()
  })

  it("delivers task:completed events to a plugin subscriber", async () => {
    await loadPlugins({
      config: fakeConfig(["agentx-plugin-echo-channel"]),
      agents: noopAgents,
      log: () => {},
      importer: async () => ({ default: echoFixture }),
    })
    expect(inspect.taskCompletedSeen).toBe(0)
    getEventBus().emit("task:completed", {
      agentId: "x", channel: "api", chatId: "y",
      durationMs: 1, at: "2026-04-30T18:00:00.000Z",
    })
    expect(inspect.taskCompletedSeen).toBe(1)
  })

  it("dispose() runs teardown and removes bus subscriptions", async () => {
    const [loaded] = await loadPlugins({
      config: fakeConfig(["agentx-plugin-echo-channel"]),
      agents: noopAgents,
      log: () => {},
      importer: async () => ({ default: echoFixture }),
    })
    await loaded.dispose()
    expect(inspect.teardownCalled).toBe(1)
    // After dispose, further bus events must not increment the counter.
    getEventBus().emit("task:completed", {
      agentId: "x", channel: "api", chatId: "y",
      durationMs: 1, at: "2026-04-30T18:01:00.000Z",
    })
    expect(inspect.taskCompletedSeen).toBe(0)
  })

  it("preserves declaration order across multiple plugins", async () => {
    const a: AgentXPlugin = { manifest: { name: "a", version: "0.1.0" }, setup: () => {} }
    const b: AgentXPlugin = { manifest: { name: "b", version: "0.1.0" }, setup: () => {} }
    const order: string[] = []
    const importer = async (n: string) => {
      order.push(n)
      return { default: n === "pkg-a" ? a : b }
    }
    const out = await loadPlugins({
      config: fakeConfig(["pkg-a", "pkg-b"]),
      agents: noopAgents,
      log: () => {},
      importer,
    })
    expect(order).toEqual(["pkg-a", "pkg-b"])
    expect(out.map((p) => p.manifest.name)).toEqual(["a", "b"])
  })

  it("loader continues when one plugin's setup() throws", async () => {
    const logs: string[] = []
    const bad: AgentXPlugin = {
      manifest: { name: "bad", version: "0.1.0" },
      setup: () => { throw new Error("kaboom") },
    }
    const good: AgentXPlugin = {
      manifest: { name: "good", version: "0.1.0" },
      setup: () => {},
    }
    const importer = async (n: string) => ({ default: n === "bad" ? bad : good })
    const out = await loadPlugins({
      config: fakeConfig(["bad", "good"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer,
    })
    expect(out.map((p) => p.manifest.name)).toEqual(["good"])
    expect(logs.some((l) => l.includes("bad") && l.includes("setup() failed"))).toBe(true)
  })

  it("subscriber that throws inside its handler does not crash sibling subscribers", async () => {
    const logs: string[] = []
    const otherSeen: any[] = []
    const angry: AgentXPlugin = {
      manifest: { name: "angry", version: "0.1.0" },
      setup: (ctx) => {
        ctx.on("task:completed", () => { throw new Error("handler died") })
      },
    }
    await loadPlugins({
      config: fakeConfig(["angry"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: async () => ({ default: angry }),
    })
    // Sibling subscriber attached directly to the bus.
    getEventBus().on("task:completed", (p) => otherSeen.push(p))
    getEventBus().emit("task:completed", {
      agentId: "x", channel: "api", chatId: "y",
      durationMs: 1, at: "2026-04-30T18:02:00.000Z",
    })
    expect(otherSeen).toHaveLength(1)
    expect(logs.some((l) => l.includes("handler died"))).toBe(true)
  })

  it("addChannel rejects collisions with built-in channel names", async () => {
    const logs: string[] = []
    const claimer: AgentXPlugin = {
      manifest: { name: "claimer", version: "0.1.0" },
      setup: (ctx) => {
        ctx.addChannel({
          name: "telegram",
          start: async () => {}, stop: async () => {},
          send: async () => {},
          onMessage: () => {},
        })
      },
    }
    const out = await loadPlugins({
      config: fakeConfig(["claimer"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: async () => ({ default: claimer }),
      isChannelNameTaken: (n) => n === "telegram",
    })
    expect(out).toHaveLength(1)
    expect(out[0].channels).toEqual([])
    expect(logs.some((l) => l.includes("already in use"))).toBe(true)
  })

  it("aborts and skips a plugin whose setup() exceeds the timeout", async () => {
    const logs: string[] = []
    const slow: AgentXPlugin = {
      manifest: { name: "slow", version: "0.1.0" },
      setup: () => new Promise(() => { /* never resolves */ }),
    }
    const out = await loadPlugins({
      config: fakeConfig(["slow"]),
      agents: noopAgents,
      log: captureLog(logs),
      importer: async () => ({ default: slow }),
      setupTimeoutMs: 30,
    })
    expect(out).toEqual([])
    expect(logs.some((l) => l.includes("slow") && l.includes("setup() failed") && l.includes("exceeded"))).toBe(true)
  })

  it("plugin sees a snapshot of the agents registry", async () => {
    let seenSize = -1
    const watcher: AgentXPlugin = {
      manifest: { name: "watcher", version: "0.1.0" },
      setup: (ctx) => { seenSize = ctx.agents.size },
    }
    const agents = new Map<string, AgentDef>([["a", { name: "a" } as AgentDef]])
    await loadPlugins({
      config: fakeConfig(["watcher"]),
      agents,
      log: () => {},
      importer: async () => ({ default: watcher }),
    })
    expect(seenSize).toBe(1)
  })
})
