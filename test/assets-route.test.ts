// /assets/ names and types (board-dashboard.ts assetContentType). The Mobile
// app page's phone screens are .webp files in the React Hub's hub/ folder
// (#2459); before this, the route answered 400 and the phone showed no screen.
import { describe, expect, it } from "vitest"
import { assetContentType } from "../src/daemon/board-dashboard"

describe("assetContentType", () => {
  it("serves the React Hub's .webp pictures as images", () => {
    expect(assetContentType("hub/chat-B1x_9aQz.webp")).toBe("image/webp")
  })

  it("keeps .webp to the hub/ folder", () => {
    expect(assetContentType("chat.webp")).toBeNull()
  })

  it("keeps the old types", () => {
    expect(assetContentType("hub/index-abc.js")).toBe("application/javascript; charset=utf-8")
    expect(assetContentType("activity-graph.global.js")).toBe("application/javascript; charset=utf-8")
    expect(assetContentType("hub/index-abc.css")).toBe("text/css; charset=utf-8")
    expect(assetContentType("Geist-Variable.woff2")).toBe("font/woff2")
  })

  it("refuses other names", () => {
    for (const rel of ["../secret.js", "hub/../x.js", "x.png", "hub/x.svg", ".env", "hub/sub/x.js"]) expect(assetContentType(rel)).toBeNull()
  })
})
