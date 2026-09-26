import { describe, it, expect } from "vitest"
import { parseDrawLine, LineSplitter, CANVAS } from "../src/teach/draw-plan"
import { drawLive, drawSnippet, toScreen } from "../src/teach/draw"
import type { Presence, Rect } from "../src/voice/presence"

const none = new Set<string>()

describe("draw plan lines", () => {
  it("reads a shape, clamped to the canvas", () => {
    const el = parseDrawLine('{"id":"sea","say":"The sea.","geo":"rectangle","x":-20,"y":500,"w":2000,"h":400,"color":"blue","fill":"fill"}', none)
    expect(el).toMatchObject({ kind: "geo", x: 0, y: 500, w: CANVAS.w, h: CANVAS.h - 500, color: "blue", fill: "fill" })
  })

  it("falls back on unknown styles instead of failing the picture", () => {
    const el = parseDrawLine('{"id":"s","geo":"blob","x":1,"y":1,"w":10,"h":10,"color":"teal","fill":"glitter"}', none)
    expect(el).toMatchObject({ geo: "rectangle", color: "black", fill: "solid" })
  })

  it("keeps an arrow only between two different known elements", () => {
    const known = new Set(["sun", "note"])
    expect(parseDrawLine('{"id":"a","arrow":["note","sun"]}', known)).toMatchObject({ kind: "arrow", from: "note", to: "sun" })
    expect(parseDrawLine('{"id":"a","arrow":["sun","sun"]}', known)).toBeNull()
    expect(parseDrawLine('{"id":"a","arrow":["note","moon"]}', known)).toBeNull()
  })

  it("ignores prose, fences, duplicates and half lines", () => {
    for (const l of ["Here is the plan:", "```json", '{"id":"x","geo":"star"', ""]) expect(parseDrawLine(l, none)).toBeNull()
    expect(parseDrawLine('{"id":"sun","text":"hi","x":1,"y":1}', new Set(["sun"]))).toBeNull()
  })

  it("reads a path, clamped, closed only with three points or more", () => {
    const el = parseDrawLine('{"id":"dome","path":[[-5,10],[50,-9],[90,10]],"color":"white","fill":"fill","opacity":0.02}', none)
    expect(el).toMatchObject({ kind: "path", pts: [[0, 10], [50, 0], [90, 10]], fill: "fill", opacity: 0.1 })
    expect(parseDrawLine('{"id":"bar","path":[[1,1],[9,9]],"fill":"none"}', none)).toMatchObject({ kind: "path", fill: "none" })
    expect(parseDrawLine('{"id":"bad","path":[[1,1],[9,9]],"fill":"fill"}', none)).toBeNull()
    expect(parseDrawLine('{"id":"bad","path":[[1,"x"],[9,9],[3,3]]}', none)).toBeNull()
  })

  it("keeps only valid palette entries, once", () => {
    const el = parseDrawLine('{"palette":{"blue":"#1F5FA6","teal":"#00ffff","red":"pink"},"say":"Colours."}', none)
    expect(el).toEqual({ kind: "palette", id: "palette", say: "Colours.", colors: { blue: "#1F5FA6" } })
    expect(parseDrawLine('{"palette":{"red":"pink"}}', none)).toBeNull()
    expect(parseDrawLine('{"palette":{"blue":"#000000"}}', new Set(["palette"]))).toBeNull()
  })

  it("splits streamed chunks into whole lines", () => {
    const s = new LineSplitter()
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(s.push(':2}\n')).toEqual(['{"b":2}'])
    expect(s.push('{"c":3}')).toEqual([])
    expect(s.flush()).toEqual(['{"c":3}'])
  })
})

describe("drawSnippet", () => {
  it("embeds model text as data, not code", () => {
    const code = drawSnippet({ kind: "text", id: "t", say: "", text: "'); evil(); ('", x: 1, y: 1, size: "l", color: "black", font: "draw" }, "run")
    expect(code).toContain(JSON.stringify("'); evil(); ('"))
    expect(() => new Function(`return (async () => { ${code} })`)).not.toThrow()
  })

  it("compiles for every kind", () => {
    const els = [
      { kind: "geo", id: "g", say: "", geo: "star", x: 1, y: 1, w: 9, h: 9, color: "red", fill: "fill", label: "x" },
      { kind: "arrow", id: "a", say: "", from: "g", to: "t", label: "", color: "black" },
      { kind: "path", id: "p", say: "", pts: [[0, 0], [10, 0], [5, 8]], color: "blue", fill: "fill", opacity: 0.5 },
      { kind: "palette", id: "palette", say: "", colors: { blue: "#1f5fa6" } },
    ] as const
    for (const el of els) expect(() => new Function(`return (async () => { ${drawSnippet(el as any, "r")} })`)).not.toThrow()
  })
})

class FakePresence implements Presence {
  moves: Rect[] = []
  said: string[] = []
  moveTo(r: Rect) { this.moves.push(r) }
  say(t: string) { this.said.push(t) }
  clear() {}
  park() {}
  close() {}
}

describe("drawLive", () => {
  const plan = [
    '{"id":"sea","say":"The sea.","geo":"rectangle","x":0,"y":400,"w":1000,"h":240,"color":"blue","fill":"fill"}\n{"id":"sun",',
    '"say":"A sun.","geo":"ellipse","x":800,"y":60,"w":120,"h":120,"color":"orange","fill":"fill"}\n',
    'not json\n{"id":"a1","say":"Look.","arrow":["sea","sun"]}\n',
    '{"id":"dot","say":"","geo":"ellipse","x":10,"y":10,"w":8,"h":8}',
  ]

  async function go(stepMs = 0) {
    const execs: string[] = []
    const api = {
      exec: async (_doc: string, code: string) => {
        execs.push(code)
        return (code.includes("zoomToBounds") ? { ox: 100, oy: 50, scale: 0.5 } : "id") as any
      },
    }
    const model = { async *reply() { for (const c of plan) yield c } }
    const presence = new FakePresence()
    let t = 0
    const events: string[] = []
    const r = await drawLive("a postcard", { api, presence, model, sleep: async (ms) => { t += ms }, now: () => t }, { docId: "d", stepMs, runTag: "r" }, (e) => events.push(e.type))
    return { r, execs, presence, events, t }
  }

  it("makes one model turn and one request per element, streamed as planned", async () => {
    const { r, execs, events } = await go()
    expect(r.steps).toBe(4)
    expect(execs).toHaveLength(5) // frame + four elements
    expect(execs[3]).toContain("createArrowBetweenShapes")
    expect(events.filter((e) => e === "skipped")).toHaveLength(1)
  })

  it("moves the presence cursor over each shape, in screen coordinates", async () => {
    const { presence } = await go()
    // Sea goes from its top-left corner to its bottom-right corner.
    expect(presence.moves[0]).toEqual({ x: 100, y: 250, width: 0, height: 0 })
    expect(presence.moves[1]).toEqual(toScreen({ ox: 100, oy: 50, scale: 0.5 }, 1000, 640))
    expect(presence.said).toEqual(["The sea.", "A sun.", "Look."])
  })

  it("holds captioned steps for stepMs and draws uncaptioned detail straight through", async () => {
    const { t, presence } = await go(1500)
    // Three captioned holds, plus the uncaptioned dot's 250 ms glide only.
    expect(t).toBe(3 * 1500 + 250)
    expect(presence.said).toEqual(["The sea.", "A sun.", "Look."])
  })
})
