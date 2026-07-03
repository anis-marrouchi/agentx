import { describe, it, expect } from "vitest"
import { extractUiDirective, stripUiDirectiveForPreview } from "../src/channels/ui-directive"

describe("extractUiDirective", () => {
  it("returns text unchanged when there is no directive", () => {
    const r = extractUiDirective("just a normal reply")
    expect(r.cleanText).toBe("just a normal reply")
    expect(r.ui).toBeUndefined()
  })

  it("lifts URL buttons and strips the fenced block", () => {
    const text = 'Here you go.\n\n```agentx:ui\n{"buttons":[{"label":"Docs","url":"https://x.dev"}]}\n```'
    const r = extractUiDirective(text)
    expect(r.cleanText).toBe("Here you go.")
    expect(r.ui?.buttons).toEqual([{ label: "Docs", url: "https://x.dev" }])
  })

  it("parses a poll", () => {
    const text = 'Pick:\n```agentx:ui\n{"poll":{"question":"Ship?","options":["Yes","No"],"multiple":true}}\n```'
    const r = extractUiDirective(text)
    expect(r.ui?.poll).toEqual({ question: "Ship?", options: ["Yes", "No"], multiple: true })
    expect(r.cleanText).toBe("Pick:")
  })

  it("parses media", () => {
    const text = 'Chart:\n```agentx:ui\n{"media":{"type":"image","url":"https://x/img.png","caption":"q3"}}\n```'
    const r = extractUiDirective(text)
    expect(r.ui?.media).toEqual({ type: "image", url: "https://x/img.png", caption: "q3" })
  })

  it("last block wins when several are present", () => {
    const text =
      '```agentx:ui\n{"buttons":[{"label":"A","url":"https://a"}]}\n```\n' +
      'and then\n```agentx:ui\n{"buttons":[{"label":"B","url":"https://b"}]}\n```'
    const r = extractUiDirective(text)
    expect(r.ui?.buttons).toEqual([{ label: "B", url: "https://b" }])
  })

  it("malformed JSON leaves the text untouched and yields no directive (never throws)", () => {
    const text = 'oops\n```agentx:ui\n{ not json ]\n```'
    const r = extractUiDirective(text)
    expect(r.ui).toBeUndefined()
    expect(r.cleanText).toBe(text)
  })

  it("drops non-https and action buttons, reports skipped actions", () => {
    const text =
      '```agentx:ui\n{"buttons":[' +
      '{"label":"Bad","url":"ftp://x"},' +
      '{"label":"Approve","action":"approve"},' +
      '{"label":"Good","url":"https://ok"}]}\n```'
    const r = extractUiDirective(text)
    expect(r.ui?.buttons).toEqual([{ label: "Good", url: "https://ok" }])
    expect(r.ui?.skippedActions).toEqual(["Approve"])
  })

  it("a poll with fewer than 2 options is rejected", () => {
    const text = '```agentx:ui\n{"poll":{"question":"?","options":["only"]}}\n```'
    const r = extractUiDirective(text)
    expect(r.ui).toBeUndefined()
  })
})

describe("stripUiDirectiveForPreview", () => {
  it("hides a complete block", () => {
    const text = 'visible\n```agentx:ui\n{"buttons":[]}\n```'
    expect(stripUiDirectiveForPreview(text)).toBe("visible")
  })

  it("hides a half-written block mid-stream", () => {
    const text = 'visible so far\n```agentx:ui\n{"buttons":[{"label'
    expect(stripUiDirectiveForPreview(text)).toBe("visible so far")
  })

  it("leaves plain text alone", () => {
    expect(stripUiDirectiveForPreview("nothing special")).toBe("nothing special")
  })
})
