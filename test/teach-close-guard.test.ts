import { describe, it, expect, vi, beforeEach } from "vitest"
const mocks = vi.hoisted(() => ({
  exec: vi.fn(), askSeat: vi.fn(), readScreen: vi.fn(),
  steps: [] as Array<Record<string, unknown>>,
}))
vi.mock("child_process", () => ({ execFile: mocks.exec, spawn: vi.fn() }))
vi.mock("fs", () => ({ existsSync: () => true, readFileSync: vi.fn(), writeFileSync: vi.fn(), unlinkSync: vi.fn(), statSync: vi.fn() }))
vi.mock("../src/decisions/seat", () => ({ askSeat: mocks.askSeat }))
vi.mock("../src/computer-use/screen", () => ({
  HELPER: "/helper", readScreen: mocks.readScreen, rectFor: () => ({ x: 10, y: 10, width: 20, height: 20 }),
}))
vi.mock("../src/computer-use/verify", () => ({ verify: vi.fn().mockResolvedValue({ ok: true, reason: "" }) }))
vi.mock("../src/teach/lessons", () => ({
  LESSONS: [{ id: "test", title: "Test", appHint: "", get steps() { return mocks.steps } }],
}))
import { teach } from "../src/commands/teach"

// A lesson step that clicks must not land on a control that closes a tab,
// window or app unless the step itself asks to close something (#1094).
const tabX = { id: 1, role: "AXButton", label: "Close", enabled: true, area: "browser", closes: true }
const star = { id: 2, role: "AXButton", label: "Bookmark this tab", enabled: true, area: "browser" }

function picks(id: number) {
  mocks.askSeat.mockResolvedValue({
    answers: {
      target: { choice: String(id), confidence: 0.9, probabilities: { [String(id)]: 0.9 } },
      present: { noul: 0.95 },
    },
  })
}

const verbs = () => mocks.exec.mock.calls.map((c) => c[1][0])

describe("teach close guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = 0
    mocks.exec.mockImplementation((_file: string, _args: string[], cb: Function) => cb(null, { stdout: '{"ok":true,"changed":true}', stderr: "" }))
    mocks.readScreen.mockResolvedValue({ app: "Google Chrome", window: "Docs", candidates: [tabX, star], usedOCR: false })
  })

  it("stops before pointing or clicking when an unrelated step matches the tab's close button", async () => {
    mocks.steps = [{ say: "Bookmark it", before: "page open", find: "bookmark this page", click: true, afterClickWaitMs: 0 }]
    picks(tabX.id)
    await teach.parseAsync(["node", "teach", "test", "--no-speak", "--no-hud"])
    expect(verbs()).not.toContain("point")
    expect(verbs()).not.toContain("click")
    expect(process.exitCode).toBe(3)
    process.exitCode = 0
  })

  it("clicks the close button when the step asks to close the tab", async () => {
    mocks.steps = [{ say: "Close it", before: "page open", find: "close this tab", click: true, afterClickWaitMs: 0 }]
    picks(tabX.id)
    await teach.parseAsync(["node", "teach", "test", "--no-speak", "--no-hud"])
    expect(verbs()).toEqual(["point", "click"])
    expect(process.exitCode).toBe(0)
  })

  it("clicks a control that does not close anything", async () => {
    mocks.steps = [{ say: "Bookmark it", before: "page open", find: "bookmark this page", click: true, afterClickWaitMs: 0 }]
    picks(star.id)
    await teach.parseAsync(["node", "teach", "test", "--no-speak", "--no-hud"])
    expect(verbs()).toEqual(["point", "click"])
    expect(process.exitCode).toBe(0)
  })
})
