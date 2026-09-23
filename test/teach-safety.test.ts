import { describe, it, expect, vi, beforeEach } from "vitest"
const mocks = vi.hoisted(() => ({ verify: vi.fn(), exec: vi.fn() }))
vi.mock("child_process", () => ({ execFile: mocks.exec, spawn: vi.fn() }))
vi.mock("fs", () => ({ existsSync: () => true, readFileSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn(), statSync: vi.fn() }))
vi.mock("../src/decisions/seat", () => ({ askSeat: vi.fn() }))
vi.mock("../src/computer-use/screen", () => ({ HELPER: "/helper", readScreen: vi.fn(), rectFor: vi.fn() }))
vi.mock("../src/computer-use/verify", () => ({ verify: mocks.verify }))
vi.mock("../src/teach/lessons", () => ({ LESSONS: [{ id: "test", title: "Test", appHint: "", steps: [{ say: "Type", before: "field focused", type: "secret", key: "return" }] }] }))
import { teach, openArgs } from "../src/commands/teach"
describe("teach action gates", () => {
  beforeEach(() => { vi.clearAllMocks(); process.exitCode = 0 })
  it.each([false, "throw"])("stops without typing or submitting when readiness is %s", async (mode) => {
    if (mode === "throw") mocks.verify.mockRejectedValue(new Error("unavailable"))
    else mocks.verify.mockResolvedValue({ ok: false, reason: "wrong screen" })
    await teach.parseAsync(["node", "teach", "test", "--no-speak", "--no-hud"])
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })
  it("opens a clean app-mode window only when asked", () => {
    const start = { app: "Google Chrome", url: "http://127.0.0.1:18931/live", ready: "ready" }
    expect(openArgs(start)).toEqual(["-a", "Google Chrome", "http://127.0.0.1:18931/live"])
    const clean = openArgs({ ...start, cleanWindow: true })
    expect(clean.slice(0, 3)).toEqual(["-na", "Google Chrome", "--args"])
    expect(clean).toContain("--app=http://127.0.0.1:18931/live")
    expect(clean.some(a => a.startsWith("--user-data-dir="))).toBe(true)
  })
})
