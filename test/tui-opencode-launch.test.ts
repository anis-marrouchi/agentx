import { describe, it, expect, vi } from "vitest"
import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { launchOpenCode, type OpenCodeServerPool } from "../src/tui/opencode-launch"
import { OpenCodeServerUnavailable } from "../src/agents/opencode-process"

// `opencode --standalone` raced its own server: on a busy machine the
// screen timed out after two seconds and closed on the user. The launcher
// now starts the server through the process pool, waits for it, and opens
// the screen against it; standalone is only the fallback.

function fakeSpawn(exitCode: number | null = 0) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
  const spawnImpl = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => {
    calls.push({ command, args, env: opts.env, cwd: opts.cwd })
    const child = new EventEmitter() as unknown as ChildProcess
    setTimeout(() => (child as unknown as EventEmitter).emit("exit", exitCode), 0)
    return child
  }
  return { calls, spawnImpl }
}

const env = { PATH: "/bin", OPENCODE_CONFIG_CONTENT: '{"model":"agentx/a"}' }

describe("launchOpenCode", () => {
  it("opens the screen against a pre-started server and stops that server afterwards", async () => {
    const release = vi.fn()
    const acquire = vi.fn(async () => ({ url: "http://127.0.0.1:4321", env: { ...env, OPENCODE_SERVER_PASSWORD: "pw" }, release }))
    const pool: OpenCodeServerPool = { acquire }
    const { calls, spawnImpl } = fakeSpawn(0)
    const log = vi.fn()
    const result = await launchOpenCode({ agentId: "a", env, cwd: "/work", pool, spawnImpl, log })
    expect(result.mode).toBe("server")
    expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ key: "tui:a", cwd: "/work", model: "agentx/a", fresh: true }))
    expect(calls[0].args).toEqual(["--server", "http://127.0.0.1:4321"])
    // The server's credentials reach the screen through its environment.
    expect(calls[0].env.OPENCODE_SERVER_PASSWORD).toBe("pw")
    expect(calls[0].env.OPENCODE_CONFIG_CONTENT).toBe(env.OPENCODE_CONFIG_CONTENT)
    expect(release).toHaveBeenCalledWith(true)
    expect(log).not.toHaveBeenCalled()
  })

  it("falls back to standalone when no server can be started", async () => {
    const pool: OpenCodeServerPool = { acquire: async () => { throw new OpenCodeServerUnavailable("Warm server capacity reached", true) } }
    const { calls, spawnImpl } = fakeSpawn(0)
    const log = vi.fn()
    const result = await launchOpenCode({ agentId: "a", env, cwd: "/work", pool, spawnImpl, log })
    expect(result.mode).toBe("standalone")
    expect(calls[0].args).toEqual(["--standalone"])
    expect(calls[0].env).toBe(env)
    expect(log.mock.calls[0][0]).toMatch(/capacity reached/)
  })

  it("surfaces other pool failures instead of hiding them", async () => {
    const pool: OpenCodeServerPool = { acquire: async () => { throw new Error("task cancelled by operator") } }
    const { spawnImpl } = fakeSpawn(0)
    await expect(launchOpenCode({ agentId: "a", env, cwd: "/work", pool, spawnImpl, log: () => {} })).rejects.toThrow(/cancelled/)
  })

  it("reports a failed screen and still stops the server", async () => {
    const release = vi.fn()
    const pool: OpenCodeServerPool = { acquire: async () => ({ url: "http://127.0.0.1:1", env, release }) }
    const { spawnImpl } = fakeSpawn(3)
    await expect(launchOpenCode({ agentId: "a", env, cwd: "/work", pool, spawnImpl, log: () => {} })).rejects.toThrow(/exited with code 3/)
    expect(release).toHaveBeenCalledWith(true)
  })
})
