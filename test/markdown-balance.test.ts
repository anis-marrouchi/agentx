import { describe, it, expect } from "vitest"
import { balanceMarkdown } from "../src/tui/markdown"

describe("balanceMarkdown (live-stream partial markers)", () => {
  it("closes an unterminated bold span", () => {
    expect(balanceMarkdown("Here is **bol")).toBe("Here is **bol**")
  })

  it("closes an unterminated inline code span", () => {
    expect(balanceMarkdown("run `npm ins")).toBe("run `npm ins`")
  })

  it("closes an unterminated code fence", () => {
    expect(balanceMarkdown("```ts\nconst x = 1")).toBe("```ts\nconst x = 1\n```")
  })

  it("balances multiple bold spans (last one open)", () => {
    expect(balanceMarkdown("**done** and **half")).toBe("**done** and **half**")
  })

  it("leaves complete markdown untouched", () => {
    const complete = "A **bold** word, `code`, and:\n```\nx\n```"
    expect(balanceMarkdown(complete)).toBe(complete)
  })

  it("does not count backticks inside a closed fence as inline", () => {
    // fence is balanced; no stray inline backtick → unchanged
    expect(balanceMarkdown("```\na `b` c\n```")).toBe("```\na `b` c\n```")
  })
})
