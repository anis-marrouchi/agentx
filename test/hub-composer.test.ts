// The React Hub's composer card (#2453): the shell chat draws the approved
// card of #2182 (To <agent>, attach, model, send arrow), not a plain bar.
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"
import { resolveHubLayout } from "../src/hub/layout"
import { SimpleShell, shellAgents, type SimpleShellProps } from "../src/hub/pages/ShellPage"
import { Composer, filesOnlyText, ownModelLabel, type ComposerAgent } from "../src/hub/shell/Composer"
import { TooltipProvider } from "../src/hub/ui"
import { ICON_NAMES } from "../src/hub/ui/icons"

const card = (agent?: ComposerAgent) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Composer, { agent, onSend: async () => true })))

function shell(p: Partial<SimpleShellProps> = {}): string {
  const props: SimpleShellProps = { view: resolveHubLayout({ layout: "simple" }), owner: true, agents: [{ id: "ada", name: "Ada", model: "claude-opus-4-6", tier: "claude-code" }], agent: "ada", ...p }
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(TooltipProvider, null, createElement(SimpleShell, props))),
  )
}

describe("the composer card", () => {
  it("says who it goes to, then attach and the send arrow", () => {
    const html = card({ id: "ada", name: "Ada" })
    expect(html).toContain('data-shell="composer"')
    expect(html).toMatch(/data-shell="to"[\s\S]*?>A<\/span>To Ada/)
    expect(html).toContain('aria-label="Attach files"')
    expect(html).toContain('type="file"')
    expect(html).toMatch(/aria-label="Send"[^>]*disabled/)
    expect(html).toContain('placeholder="Message Ada…"')
    // Not the old bar's "Send" word button.
    expect(html).not.toMatch(/<\/svg>\s*Send<\/button>/)
  })
  it("an engine with choices: the model picker, the agent's own first", () => {
    const html = card({ id: "ada", name: "Ada", model: "claude-opus-4-6", tier: "claude-code" })
    expect(html).toMatch(/<select[^>]*aria-label="Model"/)
    expect(html).toContain(">Opus (own)</option>")
    expect(html).toContain(">Sonnet</option>")
    expect(html).toContain(">Haiku</option>")
  })
  it("an engine without choices: its own model, not a picker", () => {
    const html = card({ id: "bo", name: "Bo", model: "gpt-5", tier: "codex" })
    expect(html).not.toContain("<select")
    expect(html).toMatch(/data-shell="model"[^>]*>gpt-5</)
  })
  it("no agent: no To tag, the box and attach are off", () => {
    const html = card(undefined)
    expect(html).not.toContain('data-shell="to"')
    expect(html).toMatch(/<textarea[^>]*disabled/)
    expect(html).toMatch(/aria-label="Attach files"[^>]*disabled/)
  })
  it("draws its icons from the Hub set", () => {
    for (const n of ["plus", "arrow-up", "mic", "pencil-line", "play", "x"]) expect(ICON_NAMES).toContain(n)
  })
})

describe("the card's words", () => {
  it("names the own model by its short name", () => {
    expect(ownModelLabel("claude-opus-4-6", ["opus", "sonnet", "haiku"])).toBe("Opus (own)")
    expect(ownModelLabel("custom-x", ["opus"])).toBe("custom-x (own)")
    expect(ownModelLabel(undefined, ["opus"])).toBe("Own model")
  })
  it("files alone go with the old card's words", () => {
    expect(filesOnlyText(1)).toBe("See the attached file.")
    expect(filesOnlyText(3)).toBe("See the attached files.")
  })
})

describe("the shell chat uses the card (#2453)", () => {
  it("an agent picked from the side menu gets the card, with the machine under it", () => {
    const html = shell()
    expect(html).toMatch(/data-shell="chat"[\s\S]*data-shell="composer"[\s\S]*data-shell="to"[\s\S]*To Ada[\s\S]*aria-label="Model"[\s\S]*data-shell="machine"/)
  })
  it("keeps the engine from /api/agents, for the model picker", () => {
    expect(shellAgents([{ id: "ada", name: "Ada", model: "m", tier: "claude-code" }])).toEqual([{ id: "ada", name: "Ada", model: "m", tier: "claude-code" }])
  })
})
