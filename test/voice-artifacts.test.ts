import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { voiceArtifacts } from "../src/daemon/voice-artifacts"

// #1670: the Mac widget shows the files a voice answer declares, as the
// phone app does, and never the raw <agentx-artifact> line.

const tag = (filename: string, mime: string) =>
  `<agentx-artifact>${JSON.stringify({ filename, mime })}</agentx-artifact>`

let ws: string
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), "agentx-voice-artifacts-"))
  mkdirSync(join(ws, ".agentx", "outbox"), { recursive: true })
  writeFileSync(join(ws, ".agentx", "outbox", "promo.mp4"), "x")
  writeFileSync(join(ws, ".agentx", "outbox", "chart.png"), "x")
  writeFileSync(join(ws, ".agentx", "outbox", "big.mp4"), "")
  truncateSync(join(ws, ".agentx", "outbox", "big.mp4"), 21 * 1024 * 1024)
  writeFileSync(join(ws, ".agentx", "outbox", "page.html"), "x")
})
afterAll(() => rmSync(ws, { recursive: true, force: true }))

describe("voiceArtifacts", () => {
  it("strips the lines and lists each file with the daemon path that serves it", () => {
    const text = `Here is the promo.\n${tag(".agentx/outbox/promo.mp4", "video/mp4")}\n${tag(".agentx/outbox/chart.png", "image/png")}`
    const out = voiceArtifacts(text, "secretary-agent", ws)
    expect(out.text).toBe("Here is the promo.")
    expect(out.artifacts).toEqual([
      { name: "promo.mp4", mime: "video/mp4", kind: "video", url: "/app-files?agent=secretary-agent&file=.agentx%2Foutbox%2Fpromo.mp4" },
      { name: "chart.png", mime: "image/png", kind: "image", url: "/app-files?agent=secretary-agent&file=.agentx%2Foutbox%2Fchart.png" },
    ])
  })

  it("lists a file it can't serve without a url", () => {
    const text = [
      tag(".agentx/outbox/missing.png", "image/png"),
      tag("../elsewhere/secret.png", "image/png"),
      tag(".agentx/outbox/big.mp4", "video/mp4"),
      tag(".agentx/outbox/page.html", "text/html"),
    ].join("\n")
    const out = voiceArtifacts(text, "a", ws)
    expect(out.text).toBe("")
    expect(out.artifacts.map((a) => [a.name, a.url])).toEqual([
      ["missing.png", null], ["secret.png", null], ["big.mp4", null], ["page.html", null],
    ])
  })

  it("serves nothing for an agent on another computer", () => {
    const out = voiceArtifacts(tag(".agentx/outbox/chart.png", "image/png"), "peer-agent", null)
    expect(out.artifacts).toEqual([{ name: "chart.png", mime: "image/png", kind: "image", url: null }])
  })

  it("leaves an answer without files as it was", () => {
    expect(voiceArtifacts("Done. ![Trend](https://example.com/t.png)", "a", ws))
      .toEqual({ text: "Done. ![Trend](https://example.com/t.png)", artifacts: [] })
  })
})
