import { describe, it, expect } from "vitest"
import { markdownToTelegramHtml } from "../src/channels/telegram-format"

describe("markdownToTelegramHtml", () => {
  it("converts bold", () => {
    expect(markdownToTelegramHtml("**hello**")).toBe("<b>hello</b>")
  })

  it("converts italic", () => {
    expect(markdownToTelegramHtml("*hello*")).toBe("<i>hello</i>")
  })

  it("converts bold+italic", () => {
    expect(markdownToTelegramHtml("***hello***")).toBe("<b><i>hello</i></b>")
  })

  it("converts strikethrough", () => {
    expect(markdownToTelegramHtml("~~hello~~")).toBe("<s>hello</s>")
  })

  it("converts inline code", () => {
    expect(markdownToTelegramHtml("`code`")).toBe("<code>code</code>")
  })

  it("converts code blocks", () => {
    const md = "```js\nconst x = 1\n```"
    const html = markdownToTelegramHtml(md)
    expect(html).toContain("<pre><code>")
    expect(html).toContain("const x = 1")
    expect(html).toContain("</code></pre>")
  })

  it("converts headers to bold", () => {
    expect(markdownToTelegramHtml("## Title")).toContain("<b>Title</b>")
  })

  it("converts links", () => {
    const result = markdownToTelegramHtml("[click](https://example.com)")
    expect(result).toBe('<a href="https://example.com">click</a>')
  })

  it("converts unordered lists", () => {
    expect(markdownToTelegramHtml("- item 1")).toBe("• item 1")
    expect(markdownToTelegramHtml("* item 2")).toBe("• item 2")
  })

  it("converts ordered lists", () => {
    expect(markdownToTelegramHtml("1. first")).toBe("1. first")
  })

  it("converts tables to bullet format", () => {
    const md = "| Name | Value |\n|------|-------|\n| foo | bar |"
    const result = markdownToTelegramHtml(md)
    expect(result).toContain("•")
    expect(result).toContain("<b>foo</b>")
    expect(result).toContain("bar")
  })

  it("converts blockquotes", () => {
    const result = markdownToTelegramHtml("> quoted text")
    expect(result).toContain("<blockquote>")
    expect(result).toContain("quoted text")
    expect(result).toContain("</blockquote>")
  })

  it("escapes HTML entities", () => {
    expect(markdownToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d")
  })

  it("preserves @mentions", () => {
    const result = markdownToTelegramHtml("hello @devops_bot")
    expect(result).toContain("@devops_bot")
  })

  it("wraps file extensions in code to prevent TLD previews", () => {
    const result = markdownToTelegramHtml("edit config.ts and main.py")
    expect(result).toContain("<code>.ts</code>")
    expect(result).toContain("<code>.py</code>")
  })

  it("does not wrap extensions inside code blocks", () => {
    const md = "```\nconfig.ts\n```"
    const result = markdownToTelegramHtml(md)
    // Inside <pre><code> — should NOT double-wrap
    expect(result).not.toContain("<code>.ts</code>")
  })

  it("handles empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("")
  })

  it("handles horizontal rules", () => {
    expect(markdownToTelegramHtml("---")).toBe("———")
  })
})
