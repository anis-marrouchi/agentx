import { describe, it, expect } from "vitest"
import { classifyComposerInput } from "../src/tui/composer-input"

describe("classifyComposerInput", () => {
  it("typing a character appends it", () => {
    expect(classifyComposerInput("a", false, "hel")).toEqual({ kind: "type", text: "a" })
  })

  it("a real Enter submits the buffer", () => {
    expect(classifyComposerInput("", true, "hello")).toEqual({ kind: "submit", text: "hello" })
  })

  it("a single-line text+newline chunk submits (fast typist / expect)", () => {
    expect(classifyComposerInput("world\r", false, "hello ")).toEqual({ kind: "submit", text: "hello world" })
  })

  it("a trailing backslash + Enter continues on a new line", () => {
    expect(classifyComposerInput("", true, "line1\\")).toEqual({ kind: "continue", buffer: "line1\n" })
  })

  it("a multi-line paste is preserved (not submitted at the first newline)", () => {
    expect(classifyComposerInput("alpha\nbeta\ngamma", false, "")).toEqual({ kind: "paste", text: "alpha\nbeta\ngamma" })
  })

  it("normalizes CRLF and trailing newlines in a paste", () => {
    expect(classifyComposerInput("a\r\nb\r\n", false, "x")).toEqual({ kind: "paste", text: "a\nb" })
  })

  it("an empty chunk without return is a no-op", () => {
    expect(classifyComposerInput("", false, "buf")).toEqual({ kind: "none" })
  })
})
