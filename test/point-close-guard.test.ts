import { describe, it, expect, vi, beforeEach } from "vitest"
const mocks = vi.hoisted(() => ({ exec: vi.fn(), askSeat: vi.fn(), readScreen: vi.fn(), daemon: vi.fn() }))
vi.mock("child_process", () => ({ execFile: mocks.exec, spawn: vi.fn() }))
vi.mock("fs", async (orig) => ({ ...(await orig<typeof import("fs")>()), existsSync: () => true }))
vi.mock("../src/decisions/seat", () => ({ askSeat: mocks.askSeat }))
vi.mock("../src/commands/call", () => ({ daemon: mocks.daemon }))
vi.mock("../src/computer-use/screen", () => ({
  HELPER: "/helper",
  readScreen: mocks.readScreen,
  rectFor: (_s: unknown, id: number) => ({ x: id * 10, y: 0, width: 16, height: 16 }),
}))
import { buildCandidates, type RawElement } from "../src/computer-use/candidates"
import { point } from "../src/commands/point"

// "Bookmark this page" must never land on the tab's x, even when the
// model picks it with confidence.
const el = (over: Partial<RawElement>): RawElement => ({
  id: 0, role: "AXButton", label: "", value: null, enabled: true, parent: -1, x: 0, y: 0, width: 16, height: 16, ...over,
})
const tree = [
  el({ id: 0, role: "AXWindow" }),
  el({ id: 2, role: "AXButton", label: "Close", parent: 0 }),
  el({ id: 3, role: "AXButton", label: "Bookmark this tab", parent: 0 }),
  el({ id: 4, role: "AXWebArea", parent: 0 }),
  el({ id: 5, role: "AXLink", label: "Home", parent: 4 }),
  el({ id: 6, role: "AXLink", label: "News", parent: 4 }),
]
const pick = (id: number) => ({ answers: {
  target: { choice: String(id), confidence: 0.9, probabilities: { [String(id)]: 0.9 } },
  present: { noul: 0.95 },
} })

describe("agentx point — close guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    point.setOptionValue("json", undefined) // commander keeps flags across parseAsync calls
    mocks.readScreen.mockResolvedValue({ app: "Google Chrome", window: "x", candidates: buildCandidates(tree, 40), elements: tree, usedOCR: false, ocrRects: new Map() })
    mocks.daemon.mockRejectedValue(new Error("no daemon"))
    mocks.exec.mockImplementation((_f: string, _a: string[], cb: (e: null, r: { stdout: string }) => void) => cb(null, { stdout: "{}" }))
  })

  let printed: string[] = []
  const runPoint = async (request: string, ...flags: string[]) => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`) }) as never)
    printed = []
    const said = vi.spyOn(console, "log").mockImplementation((s: unknown) => { printed.push(String(s)) })
    try {
      return await point.parseAsync([request, ...flags], { from: "user" }).then(() => "ok", (e: Error) => e.message)
    } finally {
      exit.mockRestore()
      said.mockRestore()
    }
  }

  it("does not point at the tab's x for \"Bookmark this page\", and stops", async () => {
    mocks.askSeat.mockResolvedValue(pick(2))
    expect(await runPoint("Bookmark this page")).toBe("exit 4")
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it("with --json, names the blocked control but gives no place to click", async () => {
    mocks.askSeat.mockResolvedValue(pick(2))
    expect(await runPoint("Bookmark this page", "--json")).toBe("exit 4")
    const out = JSON.parse(printed[0])
    expect(out.blocked).toBeTruthy()
    expect(out.chosen).toMatchObject({ label: "Close", closes: true })
    for (const k of ["x", "y", "width", "height"]) expect(out.chosen).not.toHaveProperty(k)
    for (const r of out.ranked) expect(r).not.toHaveProperty("x")
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it("with --json, a lone close control is refused as JSON with no place", async () => {
    const lone = [el({ id: 0, role: "AXWindow" }), el({ id: 2, role: "AXButton", label: "Close", parent: 0 })]
    mocks.readScreen.mockResolvedValue({ app: "Google Chrome", window: "x", candidates: buildCandidates(lone, 40), elements: lone, usedOCR: false, ocrRects: new Map() })
    expect(await runPoint("Bookmark this page", "--json")).toBe("exit 4")
    const out = JSON.parse(printed[0])
    expect(out.blocked).toBeTruthy()
    expect(out.chosen).toMatchObject({ label: "Close", closes: true })
    expect(out.chosen).not.toHaveProperty("x")
    expect(out).toMatchObject({ present: null, confidence: 1, ranked: [{ id: 2, score: 1, label: "Close" }] })
    expect(mocks.askSeat).not.toHaveBeenCalled()
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it("with --json, a lone control that is not blocked answers as JSON with its place", async () => {
    const lone = [el({ id: 0, role: "AXWindow" }), el({ id: 3, role: "AXButton", label: "Bookmark this tab", parent: 0 })]
    mocks.readScreen.mockResolvedValue({ app: "Google Chrome", window: "x", candidates: buildCandidates(lone, 40), elements: lone, usedOCR: false, ocrRects: new Map() })
    expect(await runPoint("Bookmark this page", "--json")).toBe("ok")
    const out = JSON.parse(printed[0])
    expect(out).not.toHaveProperty("blocked")
    expect(out.chosen).toMatchObject({ x: 30, y: 0, width: 16, height: 16, label: "Bookmark this tab" })
    expect(out).toMatchObject({ present: null, confidence: 1, ranked: [{ id: 3, score: 1 }] })
    expect(mocks.askSeat).not.toHaveBeenCalled()
  })

  it("with --json, keeps the place when nothing is blocked", async () => {
    mocks.askSeat.mockResolvedValue(pick(3))
    expect(await runPoint("Bookmark this page", "--json")).toBe("ok")
    expect(JSON.parse(printed[0]).chosen).toMatchObject({ x: 30, y: 0, width: 16, height: 16, label: "Bookmark this tab" })
  })

  it("points at it when the request asks to close the tab", async () => {
    mocks.askSeat.mockResolvedValue(pick(2))
    expect(await runPoint("close this tab")).toBe("ok")
    expect(mocks.exec).toHaveBeenCalledWith("/helper", expect.arrayContaining(["point"]), expect.any(Function))
  })

  it("points at the star for \"Bookmark this page\"", async () => {
    mocks.askSeat.mockResolvedValue(pick(3))
    expect(await runPoint("Bookmark this page")).toBe("ok")
    expect(mocks.exec).toHaveBeenCalled()
  })
})
