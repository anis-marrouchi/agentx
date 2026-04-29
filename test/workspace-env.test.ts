import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { resolve } from "path"
import { loadWorkspaceEnv, buildAgentEnv, _resetDaemonEnvKeysCache } from "../src/utils/workspace-env"

const TMP = resolve(__dirname, "../.test-workspace-env")
const WORKSPACE = resolve(TMP, "agent-workspace")
const DAEMON = resolve(TMP, "daemon")

describe("loadWorkspaceEnv", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(WORKSPACE, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it("returns empty when no env files exist", () => {
    expect(loadWorkspaceEnv(WORKSPACE)).toEqual({})
  })

  it("parses plain KEY=VALUE entries from .env", () => {
    writeFileSync(resolve(WORKSPACE, ".env"), "FOO=bar\nBAZ=qux\n")
    expect(loadWorkspaceEnv(WORKSPACE)).toEqual({ FOO: "bar", BAZ: "qux" })
  })

  it("parses shell-style `export KEY=VALUE` from .env.gitlab", () => {
    // Matches the format actually used on clawd-server's agent workspaces.
    writeFileSync(resolve(WORKSPACE, ".env.gitlab"), "export GITLAB_TOKEN=secret\nexport GITLAB_USER=pm-ksi\n")
    expect(loadWorkspaceEnv(WORKSPACE)).toEqual({ GITLAB_TOKEN: "secret", GITLAB_USER: "pm-ksi" })
  })

  it("strips surrounding single or double quotes from values", () => {
    writeFileSync(resolve(WORKSPACE, ".env"), `FOO="quoted"\nBAR='also quoted'\nBAZ=naked\n`)
    expect(loadWorkspaceEnv(WORKSPACE)).toEqual({ FOO: "quoted", BAR: "also quoted", BAZ: "naked" })
  })

  it("ignores comments and blank lines", () => {
    writeFileSync(resolve(WORKSPACE, ".env"), "# header comment\n\nFOO=bar\n# another\nBAZ=qux\n")
    expect(loadWorkspaceEnv(WORKSPACE)).toEqual({ FOO: "bar", BAZ: "qux" })
  })

  it(".env.gitlab overrides .env on key collision", () => {
    writeFileSync(resolve(WORKSPACE, ".env"), "GITLAB_TOKEN=from-env\nUNRELATED=keep\n")
    writeFileSync(resolve(WORKSPACE, ".env.gitlab"), "export GITLAB_TOKEN=from-gitlab\n")
    expect(loadWorkspaceEnv(WORKSPACE)).toEqual({ GITLAB_TOKEN: "from-gitlab", UNRELATED: "keep" })
  })
})

describe("buildAgentEnv", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(WORKSPACE, { recursive: true })
    mkdirSync(DAEMON, { recursive: true })
    _resetDaemonEnvKeysCache()
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    _resetDaemonEnvKeysCache()
  })

  it("inherits parent env when no daemon .env and no workspace env", () => {
    const env = buildAgentEnv(WORKSPACE, { PATH: "/usr/bin", HOME: "/h" }, DAEMON)
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h" })
  })

  it("strips daemon-owned keys from inherited env", () => {
    // The bug: daemon's /home/clawd/agentx/.env defines GITLAB_TOKEN, every
    // spawned agent inherits it through process.env. With the strip, agents
    // without their own workspace token get NO token (the explicit policy
    // — "every agent shall use the token found on their workspace").
    writeFileSync(resolve(DAEMON, ".env"), "GITLAB_TOKEN=daemon-secret\n")
    const env = buildAgentEnv(WORKSPACE, { PATH: "/usr/bin", GITLAB_TOKEN: "daemon-secret" }, DAEMON)
    expect(env.GITLAB_TOKEN).toBeUndefined()
    expect(env.PATH).toBe("/usr/bin")
  })

  it("workspace env overrides daemon-owned key", () => {
    writeFileSync(resolve(DAEMON, ".env"), "GITLAB_TOKEN=daemon-secret\n")
    writeFileSync(resolve(WORKSPACE, ".env.gitlab"), "export GITLAB_TOKEN=agent-secret\n")
    const env = buildAgentEnv(WORKSPACE, { PATH: "/usr/bin", GITLAB_TOKEN: "daemon-secret" }, DAEMON)
    expect(env.GITLAB_TOKEN).toBe("agent-secret")
  })

  it("workspace env layers over non-daemon-owned parent keys too", () => {
    writeFileSync(resolve(WORKSPACE, ".env"), "MY_AGENT_VAR=hello\n")
    const env = buildAgentEnv(WORKSPACE, { PATH: "/usr/bin" }, DAEMON)
    expect(env.MY_AGENT_VAR).toBe("hello")
    expect(env.PATH).toBe("/usr/bin")
  })

  it("does not strip parent-env keys that are not in the daemon .env", () => {
    writeFileSync(resolve(DAEMON, ".env"), "DAEMON_ONLY=x\n")
    // System-level vars (PATH, USER, etc.) must always survive — only keys
    // that came from the daemon's own .env get stripped.
    const env = buildAgentEnv(WORKSPACE, { PATH: "/usr/bin", USER: "alice" }, DAEMON)
    expect(env.PATH).toBe("/usr/bin")
    expect(env.USER).toBe("alice")
  })
})
