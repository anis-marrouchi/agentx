import { describe, it, expect, vi, afterEach } from "vitest"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { PERSIST_MS, PresenceHost } from "../src/daemon/voice-presence"
import { PresenceOverlay, endRecorded, posFile, reapPresence, presenceLook, systemProcesses, type Presence, type ProcessOps } from "../src/voice/presence"
import { SpeechOut } from "../src/voice/speaker"
import { Channel, type LineModel } from "../src/voice/talk-model"

const agents: any = { "secretary-agent": { name: "Secretary", systemPrompt: "You are the secretary." } }

/** Every overlay the host creates, and what was sent to it. */
function overlays() {
  const made: Array<{ agentId: string; log: string[]; alive: boolean }> = []
  const factory = (_look: any, agentId: string): Presence => {
    const o = { agentId, log: [] as string[], alive: true }
    made.push(o)
    return {
      moveTo: () => o.log.push("move"), say: (t) => o.log.push(`say ${t}`), clear: () => o.log.push("clear"),
      park: () => o.log.push("park"), ping: () => o.log.push("ping"),
      close: () => { o.log.push("close"); o.alive = false },
      get alive() { return o.alive },
    }
  }
  return { made, factory }
}

class IdleModel implements LineModel {
  reply(_m: string, signal?: AbortSignal) { const c = new Channel<string>(); signal?.addEventListener("abort", () => c.end()); return c.read(signal) }
  close() {}
}

const speech = () => new SpeechOut(async () => null, (() => { throw new Error("no audio") }) as any)

describe("PresenceHost: one overlay per agent", () => {
  afterEach(() => vi.useRealTimers())

  it("reuses the agent's overlay across spoken answers and a lesson", () => {
    const { made, factory } = overlays()
    const host = new PresenceHost(() => agents, () => {}, { overlay: factory })
    host.showTalk("secretary-agent", "First.", true)
    host.showTalk("secretary-agent", "Second.", false)
    host.lesson("secretary-agent", "open the pulls page", "teach", speech(), () => new IdleModel())
    expect(made).toHaveLength(1)
    expect(host.onScreen).toEqual(["secretary-agent"])
  })

  it("the lesson's end fades the overlay out", () => {
    const { made, factory } = overlays()
    const host = new PresenceHost(() => agents, () => {}, { overlay: factory })
    const lesson = host.lesson("secretary-agent", "x", "teach", speech(), () => new IdleModel())
    lesson.stop("stopped by the listener")
    expect(made[0].log.slice(-2)).toEqual(["say ", "close"])
    expect(host.onScreen).toEqual([])
  })

  it("an answer without persist goes once heard; with persist, after PERSIST_MS", () => {
    vi.useFakeTimers()
    const { made, factory } = overlays()
    const host = new PresenceHost(() => agents, () => {}, { overlay: factory })
    host.showTalk("secretary-agent", "Three words here.", false)
    vi.advanceTimersByTime(2_000 + 3 * 400 + 1)
    expect(made[0].alive).toBe(false)

    host.showTalk("secretary-agent", "Stay.", true)
    vi.advanceTimersByTime(10_000)
    expect(made[1].alive).toBe(true)
    expect(made[1].log).toContain("say ")
    vi.advanceTimersByTime(PERSIST_MS)
    expect(made[1].alive).toBe(false)
    expect(host.onScreen).toEqual([])
  })

  it("pings a held overlay, and redraws one whose helper has exited", () => {
    vi.useFakeTimers()
    const { made, factory } = overlays()
    const host = new PresenceHost(() => agents, () => {}, { overlay: factory })
    host.showTalk("secretary-agent", "Stay.", true)
    vi.advanceTimersByTime(45_000)
    expect(made[0].log.filter((l) => l === "ping").length).toBeGreaterThanOrEqual(2)
    made[0].alive = false // idle-exited or crashed
    host.showTalk("secretary-agent", "Again.", false)
    expect(made).toHaveLength(2)
    host.close()
    expect(made[1].alive).toBe(false)
  })

  it("hide and close leave nothing on screen", () => {
    const { made, factory } = overlays()
    const host = new PresenceHost(() => ({ ...agents, "coder-agent": { name: "Coder" } }), () => {}, { overlay: factory })
    host.showTalk("secretary-agent", "a", true)
    host.showTalk("coder-agent", "b", true)
    host.hide("secretary-agent")
    expect(host.onScreen).toEqual(["coder-agent"])
    host.close()
    expect(made.every((m) => !m.alive)).toBe(true)
  })
})

describe("machine-wide registry", () => {
  const ps = (commands: Record<number, string>, orphans: number[] = []) => {
    const killed: number[] = []
    const ops: ProcessOps = { command: (pid) => commands[pid] ?? null, kill: (pid) => { killed.push(pid) }, orphans: () => orphans }
    return { ops, killed }
  }

  it("ends the recorded overlay only if it is still a presence helper", () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"))
    writeFileSync(join(dir, "secretary-agent.pid"), "111")
    writeFileSync(join(dir, "coder-agent.pid"), "222")
    const { ops, killed } = ps({ 111: "/Applications/AgentX Helper.app/Contents/MacOS/agentx-mac-helper presence --name Secretary", 222: "/usr/bin/vim notes" })
    endRecorded("secretary-agent", dir, ops)
    endRecorded("coder-agent", dir, ops)
    expect(killed).toEqual([111])
    expect(existsSync(join(dir, "secretary-agent.pid"))).toBe(false)
  })

  it("reaps recorded overlays and orphaned helpers on start", () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"))
    writeFileSync(join(dir, "secretary-agent.pid"), "111")
    const { ops, killed } = ps({ 111: "agentx-mac-helper presence --name Secretary" }, [333])
    expect(reapPresence(dir, ops)).toBe(2)
    expect(killed).toEqual([111, 333])
    expect(reapPresence(join(dir, "missing"), ps({}).ops)).toBe(0)
  })

  it("keeps where the person dragged a tag across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"))
    writeFileSync(posFile(dir, "secretary-agent"), '{"x":40,"y":900}')
    reapPresence(dir, ps({}).ops)
    endRecorded("secretary-agent", dir, ps({}).ops)
    expect(readFileSync(posFile(dir, "secretary-agent"), "utf8")).toBe('{"x":40,"y":900}')
  })
})

describe("PresenceOverlay process", () => {
  it.skipIf(process.platform === "win32")("records its pid, replaces the previous overlay for the agent, and clears the record on exit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"))
    // A stand-in helper with the real name, so the ps check recognises it.
    const helper = join(dir, "agentx-mac-helper")
    writeFileSync(helper, "#!/bin/sh\nexec cat >/dev/null\n")
    chmodSync(helper, 0o755)
    const look = presenceLook("secretary-agent", agents["secretary-agent"])
    const pidOf = () => readFileSync(join(dir, "secretary-agent.pid"), "utf8").trim()
    const running = (pid: string) => systemProcesses.command(Number(pid)) !== null
    const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50)) }

    const first = new PresenceOverlay(look, helper, "secretary-agent", dir)
    const firstPid = pidOf()
    await until(() => (systemProcesses.command(Number(firstPid)) ?? "").includes("presence"))
    const second = new PresenceOverlay(look, helper, "secretary-agent", dir)
    const secondPid = pidOf()
    expect(secondPid).not.toBe(firstPid)
    await until(() => !running(firstPid) && !first.alive)
    expect(running(firstPid)).toBe(false)
    expect(first.alive).toBe(false)
    expect(second.alive).toBe(true)

    second.close()
    await until(() => !running(secondPid) && !existsSync(join(dir, "secretary-agent.pid")))
    expect(running(secondPid)).toBe(false)
    expect(existsSync(join(dir, "secretary-agent.pid"))).toBe(false)
  })

  it.skipIf(process.platform === "win32")("tells the helper where this agent's tag position lives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "presence-"))
    const helper = join(dir, "agentx-mac-helper")
    writeFileSync(helper, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\ncat >/dev/null\n`)
    chmodSync(helper, 0o755)
    const overlay = new PresenceOverlay(presenceLook("secretary-agent", agents["secretary-agent"]), helper, "team/secretary", dir)
    for (let i = 0; i < 100 && !existsSync(join(dir, "args")); i++) await new Promise((r) => setTimeout(r, 50))
    const args = readFileSync(join(dir, "args"), "utf8").split("\n")
    expect(args[args.indexOf("--pos-file") + 1]).toBe(join(dir, "team_secretary.pos"))
    overlay.close()
  })
})
