import { describe, expect, it } from "vitest"
import { wallBuildHtml, WALL_BUILD_TITLES } from "../src/daemon/ui/pages/wall-build"
import { renderWallPage } from "../src/daemon/ui/pages/wall"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import { TOPBAR_SCRIPT } from "../src/daemon/topbar"

// The running build on the Wall (#1444): version, short commit, since, and
// "restart pending" under the classic top bar's rule and hover text.

const BUILD = { node: "node-a", version: "1.4.0", commit: "abc1234", startedAt: "2026-03-10T11:21:00.000Z", diskNewer: false }
const line = (b: any, since = "2026-03-10 12:21 UTC+01:00") => wallBuildHtml(b, since, WALL_BUILD_TITLES)

describe("Wall build line", () => {
  it("shows version, commit and since, with the top bar's hover text", () => {
    const { html, title } = line(BUILD)
    expect(html).toContain("1.4.0 · abc1234")
    expect(html).toContain("since 2026-03-10 12:21 UTC+01:00")
    expect(html).not.toContain("restart pending")
    expect(title).toBe(WALL_BUILD_TITLES.ok + " Node: node-a")
  })

  it("adds restart pending when the disk is newer, linking to Wall Live", () => {
    const { html, title } = line({ ...BUILD, diskNewer: true })
    expect(html).toContain('<a class="chip chip--warn" role="status" href="#page=live">restart pending</a>')
    expect(title).toBe(WALL_BUILD_TITLES.stale + " Node: node-a")
  })

  it("uses the same hover text as the classic top bar", () => {
    expect(TOPBAR_SCRIPT).toContain(JSON.stringify(WALL_BUILD_TITLES.stale))
    expect(TOPBAR_SCRIPT).toContain(JSON.stringify(WALL_BUILD_TITLES.ok))
  })

  it("cuts a full hash to seven and keeps a dirty mark", () => {
    expect(line({ ...BUILD, commit: "0123456789abcdef0123456789abcdef01234567" }).html).toContain("1.4.0 · 0123456<")
    expect(line({ ...BUILD, commit: "abc1234-dirty" }).html).toContain("1.4.0 · abc1234-dirty")
  })

  it("shows nothing while loading or with no version, and says so when the daemon does not answer", () => {
    expect(line(undefined).html).toBe("")
    expect(line({ ...BUILD, version: null }).html).toBe("")
    expect(line(null).html).toContain("not reachable")
  })

  it("escapes what the daemon sends and leaves out a missing since", () => {
    const { html } = line({ ...BUILD, version: "<b>1</b>" }, "")
    expect(html).toContain("&lt;b&gt;1&lt;/b&gt;")
    expect(html).not.toContain("since")
  })

  it("sits in the Wall header and is asked with every load", () => {
    expect(renderWallPage()).toContain('<span class="ax-wall__build" id="wall-build" hidden></span>')
    expect(WALL_PAGE_SCRIPT).toContain("fetch('/api/node/build')")
    expect(WALL_PAGE_SCRIPT).toMatch(/async function load\(\) \{\s*loadBuild\(\);/)
  })
})
