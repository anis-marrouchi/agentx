import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { codexAuthHasLogin, codexCredentialsStore, readCodexLoginState } from "../src/agents/codex-login"

// #2347 note: an added Codex account shows "Signed out" when its CODEX_HOME
// has no login, and nothing when the login cannot be read here (keyring).
describe("readCodexLoginState", () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "codex-login-")) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("no auth.json (never signed in, or codex logout) is signed out", async () => {
    expect(await readCodexLoginState(dir)).toBe("signed-out")
  })

  it("a folder that does not exist is signed out", async () => {
    expect(await readCodexLoginState(join(dir, "nope"))).toBe("signed-out")
  })

  it("ChatGPT tokens or an API key are signed in", async () => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "a", refresh_token: "r" } }))
    expect(await readCodexLoginState(dir)).toBe("signed-in")
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-x", tokens: null }))
    expect(await readCodexLoginState(dir)).toBe("signed-in")
  })

  it("an auth.json with neither is signed out; one that is not JSON is unknown", async () => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: null }))
    expect(await readCodexLoginState(dir)).toBe("signed-out")
    writeFileSync(join(dir, "auth.json"), "{half")
    expect(await readCodexLoginState(dir)).toBe("unknown")
  })

  it("a login kept in the keyring is unknown, as AgentX does not open the keyring", async () => {
    writeFileSync(join(dir, "config.toml"), 'model = "gpt-5"\ncli_auth_credentials_store = "keyring"\n')
    expect(await readCodexLoginState(dir)).toBe("unknown")
    writeFileSync(join(dir, "config.toml"), "cli_auth_credentials_store = 'auto'\n")
    expect(await readCodexLoginState(dir)).toBe("unknown")
    writeFileSync(join(dir, "config.toml"), 'cli_auth_credentials_store = "file"\n')
    expect(await readCodexLoginState(dir)).toBe("signed-out")
  })
})

describe("codex-login parsers", () => {
  it("reads the credentials store, ignoring a commented line", () => {
    expect(codexCredentialsStore('# cli_auth_credentials_store = "keyring"\n')).toBeNull()
    expect(codexCredentialsStore('  cli_auth_credentials_store="keyring"')).toBe("keyring")
  })

  it("an empty API key and empty tokens object are no login", () => {
    expect(codexAuthHasLogin(JSON.stringify({ OPENAI_API_KEY: "", tokens: {} }))).toBe(false)
    expect(codexAuthHasLogin("null")).toBeNull()
  })
})
