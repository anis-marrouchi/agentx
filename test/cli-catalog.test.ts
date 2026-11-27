import { afterEach, describe, expect, it, vi } from "vitest"

// cliLoggedIn finds the CLI on the PATH; here every CLI is /bin/echo, so a
// status command prints its own args and the test controls the output.
vi.mock("../src/voice/transcribe", () => ({ findBinary: () => "/bin/echo" }))

import { accountClis, cliByCommand, getConventions, parseAuthStatus } from "../src/agents/conventions"
import { SEED_MODELS, seedModels } from "../src/agents/conventions/seed-models"
import { CLI_PROVIDERS } from "../src/agents/cli-accounts"
import { cliLoggedIn } from "../src/utils/cli-login"
import { MODEL_CHOICES } from "../src/daemon/assistant-model"
import { MODEL_GROUPS } from "../src/hub/settings/agent-data"

// #2349 PR 1: one catalog entry owns each CLI fact; the lists are read from it.
describe("the CLI catalog", () => {
  const claude = getConventions("claude-code")!.cli!
  const saved = { label: claude.label, status: claude.signInStatus }
  afterEach(() => { claude.label = saved.label; claude.signInStatus = saved.status })

  it("names the CLIs it runs, and sdk/orchestrator are not CLIs", () => {
    expect(getConventions("claude-code")?.cli?.command).toBe("claude")
    expect(getConventions("codex-cli")?.cli?.command).toBe("codex")
    expect(getConventions("opencode")?.cli?.command).toBe("opencode")
    expect(getConventions("sdk")?.cli).toBeUndefined()
    expect(getConventions("orchestrator")?.cli).toBeUndefined()
    expect(cliByCommand("nope")).toBeNull()
  })

  it("builds CLI_PROVIDERS from the entries that have an account (C7)", () => {
    expect(Object.keys(CLI_PROVIDERS)).toEqual(accountClis().map((c) => c.account.provider))
    expect(Object.keys(CLI_PROVIDERS)).toEqual(["claude", "codex"])
    expect(CLI_PROVIDERS.claude).toMatchObject({ label: "Claude Code", envVar: "CLAUDE_CONFIG_DIR" })
    expect(CLI_PROVIDERS.codex.defaultDir("/h")).toBe("/h/.codex")
  })

  it("reads the sign-in check from the entry: changing it changes cliLoggedIn", () => {
    claude.signInStatus = { args: ['{"loggedIn":true}'], parse: parseAuthStatus }
    expect(cliLoggedIn("claude")).toBe(true)
    claude.signInStatus = { args: ['{"loggedIn":false}'], parse: parseAuthStatus }
    expect(cliLoggedIn("claude")).toBe(false)
    claude.signInStatus = undefined
    expect(cliLoggedIn("claude")).toBeNull()
    // A CLI with no status command is unknown, as before.
    expect(cliLoggedIn("codex")).toBeNull()
  })

  it("feeds every picker from the seed lists", () => {
    expect(MODEL_GROUPS.find((g) => g.tier === "codex-cli")?.models).toEqual(SEED_MODELS["codex-cli"].map((m) => m.id))
    expect(MODEL_GROUPS.find((g) => g.tier === "claude-code")?.models).toContain("claude-opus-5-5")
    expect(MODEL_CHOICES["claude-code"]).toEqual(["opus", "sonnet", "haiku"])
    expect(seedModels("sdk").map((m) => m.id)).toContain("claude-sonnet-4-20250514")
    expect(seedModels("unknown")).toEqual([])
  })

  it("keeps each seeded id safe to pass as a flag value", () => {
    for (const models of Object.values(SEED_MODELS)) {
      for (const m of models) {
        expect(m.id).toMatch(/^[A-Za-z0-9][\w.:/-]*$/)
        if (m.choice) expect(m.choice).toMatch(/^[a-z0-9][\w.:/-]*$/)
      }
    }
  })
})
