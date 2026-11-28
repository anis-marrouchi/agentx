import { describe, expect, it } from "vitest"
import {
  agmCreateErrors, agmCreateSteps, agmEditSteps, agmField, agmFieldProblem, agmFields, agmFirstError, agmFormOf, agmLimits,
  agmModelGroups, agmModelHelp, agmSlug, agmWorkspacePath, INSTRUCTIONS_MAX, MODEL_GROUPS,
} from "../src/agents/agent-form"
import { seedModels } from "../src/agents/conventions/seed-models"
import { INSTRUCTIONS_MAX as SETTINGS_MAX, MODEL_GROUPS as SETTINGS_MODELS } from "../src/hub/settings/agent-data"
import { injectFns } from "../src/daemon/ui/inject"
import {
  agmActsHtml, agmEsc, agmFormHtml, agmIcon, agmRemoveHtml, agmStatus, agmWorkspaceLine,
} from "../src/daemon/ui/pages/wall-agents"

// The one agent form (#2144): the fields, checks and call plans the Hub's
// Agents page, Settings and the server share.

describe("the one agent form", () => {
  it("lists each field once, basic first, with a label and one line of help", () => {
    const keys = agmFields().map((f) => f.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.slice(0, 3)).toEqual(["name", "id", "role"])
    expect(agmFields().filter((f) => f.group === "channels").every((f) => f.only === "new")).toBe(true)
    expect(agmField("triggers").group).toBe("advanced")
    expect(agmField("workspace").only).toBe("new")
  })

  it("is the one source of the limit and the model lists, for Settings too", () => {
    expect(INSTRUCTIONS_MAX).toBe(agmLimits().instructions)
    expect(SETTINGS_MAX).toBe(INSTRUCTIONS_MAX)
    expect(SETTINGS_MODELS).toBe(MODEL_GROUPS)
    expect(agmModelGroups().find((g) => g.tier === "claude-code")!.models).toEqual(seedModels("claude-code").map((m) => m.id))
    expect(agmModelGroups().find((g) => g.tier === "codex-cli")!.models).toEqual(seedModels("codex-cli").map((m) => m.id))
    // A typed model not in the list is kept, checked on first run.
    expect(agmModelHelp("claude-opus-5-5")).toBe("")
    expect(agmModelHelp("my-model")).toBe("Not in the list: checked on first run")
    expect(agmModelHelp("")).toBe(agmField("model").help)
  })

  it("says what is wrong with each field, with the sentences the server uses", () => {
    expect(agmFieldProblem("name", " ")).toBe("Give the agent a name.")
    expect(agmFieldProblem("id", "Sales")).toMatch(/lowercase/)
    expect(agmFieldProblem("instructions", "a".repeat(INSTRUCTIONS_MAX))).toBe("")
    expect(agmFieldProblem("instructions", "a".repeat(INSTRUCTIONS_MAX + 1))).toMatch(/up to 4000 characters/)
    expect(agmFieldProblem("discordEnv", "abc")).toMatch(/^Discord bot token: write the environment variable's name in capitals/)
    const e = agmCreateErrors({ slackBotEnv: "SLACK_BOT" })
    expect(e).toMatchObject({ name: "Give the agent a name.", slackAppEnv: expect.stringMatching(/both token names/) })
    // No second error for an empty id when the name is missing.
    expect(e.id).toBeUndefined()
    expect(agmFirstError(e)).toBe("Give the agent a name.")
  })

  it("plans a create and an edit with the errors per field", () => {
    expect(agmCreateSteps({ name: "Sales Desk" }).steps[0].body).toEqual({ id: "sales-desk", name: "Sales Desk", triggerWords: "@sales-desk", tier: "claude-code" })
    const a = { id: "cx", name: "CX", mentions: ["@cx"], systemPrompt: "" }
    const bad = agmEditSteps(a, "", false, { ...agmFormOf(a, ""), name: "", triggers: "" })
    expect(bad.errors).toMatchObject({ name: "Give the agent a name.", triggers: expect.stringMatching(/wake word/) })
    expect(agmSlug("Équipe Ventes!")).toBe("equipe-ventes")
  })

  it("resolves the workspace as the server does: default, home, relative, refused", () => {
    expect(agmWorkspacePath("", "ops", "/d", "/h")).toEqual({ path: "/d/agents/ops", custom: false, relative: false, error: "" })
    expect(agmWorkspacePath("~/w/../ops", "ops", "/d", "/h").path).toBe("/h/ops")
    expect(agmWorkspacePath("work/ops", "ops", "/d", "/h")).toMatchObject({ path: "/d/work/ops", relative: true })
    expect(agmWorkspacePath("~/x", "ops", "/d", "").error).toMatch(/full path/)
    expect(agmWorkspacePath("a\nb", "ops", "/d", "/h").error).toMatch(/one line/)
    expect(agmWorkspaceLine({ name: "Sales" }, "/d", "/h")).toBe("Resolves to <code>/d/agents/sales</code>")
    expect(agmWorkspaceLine({ name: "S", workspace: "<x>" }, "/d", "/h")).toBe("Resolves to <code>/d/&lt;x&gt;</code>")
  })
})

describe("the Sheet's markup", () => {
  const ENGINES: Array<[string, string]> = [["claude-code", "Claude Code"], ["codex-cli", "Codex"]]
  it("puts each error under its field, folds Channels and Advanced, opens a fold with an error", () => {
    const html = agmFormHtml({ name: "" }, "new", ENGINES, { errors: { name: "Give the agent a name.", triggers: "Keep one." }, base: "/d", home: "/h" })
    expect(html).toContain('aria-invalid="true" aria-describedby="agm-e-name"')
    expect(html).toContain('<p class="agm-err" id="agm-e-name">Give the agent a name.</p>')
    expect(html).toMatch(/data-agm-fold="channels">/)
    expect(html).toMatch(/data-agm-fold="advanced" open>/)
    expect(html).toContain('<span id="agm-ws">Resolves to <code>/d/agents/&lt;id&gt;</code></span>')
    // One primary button; Cancel is ghost; Esc and the scrim close it.
    expect(html.match(/ax-btn--primary/g)).toHaveLength(1)
    expect(html).toContain('class="ax-btn ax-btn--ghost" data-agm-act="close">Cancel')
    expect(html).toContain('data-tip-key="Esc"')
    expect(html).toContain('<option value="claude-opus-5-5">')
  })
  it("draws the … menu only when open, Remove last and red", () => {
    const st = agmStatus({ running: 0, needs: 0, hold: "", started: true })
    expect(agmActsHtml("cx", "CX", st, "", "")).toContain('aria-expanded="false"')
    const open = agmActsHtml("cx", "CX", st, "", "cx")
    expect(open).toContain('aria-expanded="true"')
    expect(open.indexOf("Test drive")).toBeLessThan(open.indexOf("Remove…"))
    expect(open).toContain('class="is-danger" data-agm-act="ask"')
    expect(agmRemoveHtml({ id: "cx", name: "CX", workspace: "/w", running: 1 })).toContain("@cx has 1 task running.")
  })
})

describe("shipped to the page", () => {
  it("every function runs with no module scope, as injectFns ships it", () => {
    const fns = {
      agmField, agmFields, agmLimits, agmModelGroups, agmModelHelp, agmSlug, agmFieldProblem, agmCreateErrors, agmFirstError, agmCreateSteps, agmFormOf, agmEditSteps, agmWorkspacePath,
      agmEsc, agmIcon, agmStatus, agmWorkspaceLine, agmFormHtml, agmActsHtml, agmRemoveHtml,
    }
    const g: Record<string, unknown> = {}
    // The page's own global scope, without the server's globals.
    // A body that still names a module import (__vite_ssr_import_0__) throws here.
    new Function("globalThis", injectFns(fns as Record<string, Function>))(g)
    const html = (g.agmFormHtml as typeof agmFormHtml)({ name: "Sales" }, "new", [["claude-code", "Claude Code"]], { base: "/d", home: "/h" })
    expect(html).toContain("Resolves to <code>/d/agents/sales</code>")
    expect(html).toContain('<option value="claude-sonnet-5-5">')
    expect((g.agmActsHtml as typeof agmActsHtml)("cx", "CX", agmStatus({ running: 0, needs: 0, hold: "", started: true }), "", "cx")).toContain("<svg")
    expect((g.agmCreateSteps as typeof agmCreateSteps)({ name: "X", instructions: "a".repeat(4001) }).error).toMatch(/up to 4000/)
  })
})
