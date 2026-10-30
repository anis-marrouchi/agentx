import { describe, expect, it } from "vitest"
import { findOldNames, kindOf, stripCodeComments } from "../scripts/hub-name-check-lib.mjs"
import { HUB_PATH, hubRedirect } from "../src/daemon/ui/hub-name"

describe("hubRedirect (#1485)", () => {
  it("sends every old address to the same Hub page, query kept", () => {
    expect(hubRedirect("/wall")).toBe(HUB_PATH)
    expect(hubRedirect("/wall/", "?a=1")).toBe(`${HUB_PATH}/?a=1`)
    expect(hubRedirect("/wall/x", "?a=1")).toBe(`${HUB_PATH}/x?a=1`)
  })

  it("leaves every other address alone", () => {
    for (const p of ["/hub", "/wallet", "/walls", "/api/admin/wall", "/", "/live"]) expect(hubRedirect(p)).toBeNull()
  })
})

describe("the Hub name check (#1485)", () => {
  it("finds the old name in visible code text", () => {
    expect(findOldNames(`const t = "Open the Wall"`, "code")).toEqual([{ line: 1, name: "Wall", text: `const t = "Open the Wall"` }])
    expect(findOldNames(`x\nlabel: "Wall's Cost page"`, "code").map((h: { line: number }) => h.line)).toEqual([2])
  })

  it("allows comments, identifiers, paths and longer words", () => {
    const code = [
      "// the Wall's feed",
      "/* the Wall */ const a = 1",
      "renderWallPage(); import x from './wall'",
      'const u = "https://example.com/Wall"',
      "const w = wallClock; const s = \"Wall-clock time\"",
    ].join("\n")
    expect(findOldNames(code, "code")).toEqual([
      { line: 4, name: "Wall", text: 'const u = "https://example.com/Wall"' },
    ])
    expect(stripCodeComments("a // b\nc /* d\ne */ f")).toBe("a \nc \n f")
  })

  it("reads markdown text, not its code", () => {
    const md = "# The Wall\n\n`Wall` in code\n\n```\nWall\n```\n<!-- Wall -->\nwall clock"
    expect(findOldNames(md, "markdown").map((h: { line: number }) => h.line)).toEqual([1])
  })

  it("checks code and docs, skips tests and other files", () => {
    expect(kindOf("docs/dashboard/hub.md")).toBe("markdown")
    expect(kindOf("src/daemon/ui/pages/wall.ts")).toBe("code")
    expect(kindOf("test/wall.test.ts")).toBeNull()
    expect(kindOf("src/x.test.ts")).toBeNull()
    expect(kindOf("docs/public/x.png")).toBeNull()
  })
})
