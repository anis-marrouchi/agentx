import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EventEmitter } from "events"
import { spawn } from "child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { resolve } from "path"
import { installCliSignalExit } from "../src/utils/signal-exit"
import {
  SHUTDOWN_REQUEST_FILE, describeShutdown, serviceManager, startsNewWork, takeShutdownRequest, writeShutdownRequest,
} from "../src/daemon/shutdown"

function fakeProcess() {
  const em = new EventEmitter() as EventEmitter & { exit: ReturnType<typeof vi.fn> }
  em.exit = vi.fn()
  return em
}

describe("installCliSignalExit", () => {
  it("exits at once when no command handles the signal", () => {
    const p = fakeProcess()
    installCliSignalExit(p as any)
    p.emit("SIGTERM")
    expect(p.exit).toHaveBeenCalledWith(0)
  })

  it("leaves the stop to a command that handles it (the daemon's drain)", () => {
    const p = fakeProcess()
    installCliSignalExit(p as any)
    const drain = vi.fn()
    p.on("SIGTERM", drain)
    p.emit("SIGTERM")
    expect(drain).toHaveBeenCalled()
    expect(p.exit).not.toHaveBeenCalled()
  })

  it("a second Ctrl-C still exits once a one-shot handler has run", () => {
    const p = fakeProcess()
    installCliSignalExit(p as any)
    p.once("SIGINT", () => {})
    p.emit("SIGINT")
    expect(p.exit).not.toHaveBeenCalled()
    p.emit("SIGINT")
    expect(p.exit).toHaveBeenCalledWith(0)
  })
})

describe("SIGTERM on a real process", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "agentx-sig-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("lets the command's own handler finish before the process exits", async () => {
    const done = resolve(dir, "drained")
    const script = resolve(dir, "child.ts")
    writeFileSync(script, `
      import { installCliSignalExit } from ${JSON.stringify(resolve(__dirname, "../src/utils/signal-exit.ts"))}
      import { writeFileSync } from "fs"
      installCliSignalExit()
      process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(done)}, "ok"); process.exit(0) }, 300))
      console.log("ready")
      setInterval(() => {}, 1000)
    `)
    const tsx = resolve(__dirname, "../node_modules/.bin/tsx")
    const child = spawn(tsx, [script], { stdio: ["ignore", "pipe", "inherit"] })
    await new Promise<void>((r) => child.stdout!.on("data", (d) => { if (String(d).includes("ready")) r() }))
    child.kill("SIGTERM")
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)))
    expect(code).toBe(0)
    expect(existsSync(done)).toBe(true)
  }, 20_000)
})

describe("startsNewWork", () => {
  it("refuses requests that would start an agent run", () => {
    for (const [m, p] of [
      ["POST", "/task"], ["POST", "/ask"], ["GET", "/ask"], ["POST", "/mesh/task"], ["POST", "/workflow/event"],
      ["POST", "/webhook/ops/github"], ["POST", "/routines/nightly/fire"], ["POST", "/v1/chat/completions"],
      ["POST", "/workflows/deploy/run"], ["POST", "/api/tasks/123-abc/followup"], ["POST", "/talk"],
    ]) expect(startsNewWork(m, p), `${m} ${p}`).toBe(true)
  })

  it("keeps what in-flight agents need to finish their turn", () => {
    for (const [m, p] of [
      ["POST", "/api/memory"], ["POST", "/guard/check"], ["POST", "/channel/send"], ["POST", "/gitlab/send-note"],
      ["GET", "/agents"], ["GET", "/health"], ["POST", "/api/tasks/123-abc/cancel"], ["DELETE", "/api/memory/x"],
    ]) expect(startsNewWork(m, p), `${m} ${p}`).toBe(false)
  })
})

describe("shutdown reason", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), "agentx-stop-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("names who asked, then forgets it so a later stop isn't misattributed", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z")
    writeShutdownRequest(dir, { by: "agentx daemon stop", pid: 4242, at: new Date(now - 5000).toISOString() })
    const req = takeShutdownRequest(dir, now)
    expect(req).toMatchObject({ by: "agentx daemon stop", pid: 4242 })
    expect(existsSync(resolve(dir, SHUTDOWN_REQUEST_FILE))).toBe(false)
    expect(takeShutdownRequest(dir, now)).toBeNull()
  })

  it("ignores a stale request", () => {
    const now = Date.parse("2026-09-26T12:00:00.000Z")
    writeShutdownRequest(dir, { by: "agentx daemon stop", pid: 1, at: new Date(now - 3_600_000).toISOString() })
    expect(takeShutdownRequest(dir, now)).toBeNull()
  })

  it("falls back to the service manager, then to unknown", () => {
    expect(serviceManager({ INVOCATION_ID: "abc" })).toBe("systemd")
    expect(serviceManager({ XPC_SERVICE_NAME: "com.example.agentx" })).toBe("launchd (com.example.agentx)")
    expect(serviceManager({ XPC_SERVICE_NAME: "0" })).toBeNull()
    expect(serviceManager({})).toBeNull()
  })

  it("writes one readable line", () => {
    expect(describeShutdown({ signal: "SIGTERM", request: { by: "agentx daemon stop", pid: 7, at: "" }, manager: "systemd", inflight: 2, uptimeSec: 7200 }))
      .toBe("Shutdown: SIGTERM requested by agentx daemon stop (pid 7); 2 task(s) in flight; up 2.0h")
    expect(describeShutdown({ signal: "SIGINT", request: null, manager: null, inflight: 0, uptimeSec: 90 }))
      .toBe("Shutdown: SIGINT sender unknown; 0 task(s) in flight; up 2m")
  })
})
