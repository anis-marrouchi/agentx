import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { loadReferences } from "../src/agents/references/loader"
import { loadRecipes, resolveRecipes } from "../src/agents/references/recipes"

let tmp: string

function write(rel: string, content: string) {
  const abs = path.join(tmp, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "recipes-"))
  // Reference cards
  write(
    "references/initech/ssh.yaml",
    [
      "namespace: initech.ssh",
      "cards:",
      "  - id: peer-mac",
      "    kind: ssh",
      "    summary: peer-server",
      "    fields: { user: peer, host: 203.0.113.10 }",
      "    tags: [deploy]",
      "  - id: initech-server",
      "    kind: ssh",
      "    summary: Initech V1 production",
      "    fields: { user: root, host: 203.0.113.11 }",
      "    tags: [deploy, initech-v1]",
    ].join("\n"),
  )
  write(
    "references/initech/contacts.yaml",
    [
      "namespace: initech.contacts",
      "cards:",
      "  - id: pm",
      "    kind: contact",
      "    summary: Initech PM",
      "    fields: { email: pm@initech.example.com }",
      "    tags: []",
      "  - id: dev",
      "    kind: contact",
      "    summary: Initech dev lead",
      "    fields: { email: dev@initech.example.com }",
      "    tags: []",
    ].join("\n"),
  )
  // Recipes
  write(
    "references/recipes/initech.yaml",
    [
      "recipes:",
      "  - id: initech-devops",
      "    when:",
      "      agentIds: [devops-agent, coder-agent]",
      "      messageRegex: ['deploy|ssh|server|restart']",
      "    references: [initech.ssh.peer-mac, initech.ssh.initech-server]",
      "    skills: [initech-v2-deploy]",
      "  - id: initech-cx",
      "    when:",
      "      agentIds: [cx-agent]",
      "      messageRegex: ['email|client|hotmail']",
      "    references: [initech.contacts.*]",
      "    skills: [initech-cx-email, hotmail]",
      "  - id: missing-ref",
      "    when:",
      "      agentIds: [pm-initech]",
      "    references: [initech.does.not.exist]",
    ].join("\n"),
  )
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("resolveRecipes", () => {
  it("matches by agentId + message regex and returns cards", async () => {
    const refs = await loadReferences(tmp)
    const recipes = await loadRecipes(tmp)
    const result = resolveRecipes(
      { agentId: "devops-agent", message: "please deploy v2" },
      recipes,
      refs,
    )
    expect(result.matched.map(r => r.id)).toContain("initech-devops")
    const ids = result.cards.map(c => c.id).sort()
    expect(ids).toEqual(["initech.ssh.initech-server", "initech.ssh.peer-mac"])
    expect(result.requiredSkills).toContain("initech-v2-deploy")
  })

  it("expands trailing .* into all matching ids", async () => {
    const refs = await loadReferences(tmp)
    const recipes = await loadRecipes(tmp)
    const result = resolveRecipes(
      { agentId: "cx-agent", message: "send the client an email" },
      recipes,
      refs,
    )
    const ids = result.cards.map(c => c.id).sort()
    expect(ids).toEqual(["initech.contacts.dev", "initech.contacts.pm"])
    expect(result.requiredSkills.sort()).toEqual(["hotmail", "initech-cx-email"])
  })

  it("does not match when agentId is wrong", async () => {
    const refs = await loadReferences(tmp)
    const recipes = await loadRecipes(tmp)
    const result = resolveRecipes(
      { agentId: "marketing-agent", message: "deploy the staging server" },
      recipes,
      refs,
    )
    expect(result.matched).toHaveLength(0)
    expect(result.cards).toHaveLength(0)
  })

  it("collects unresolved reference ids for the audit lint", async () => {
    const refs = await loadReferences(tmp)
    const recipes = await loadRecipes(tmp)
    const result = resolveRecipes(
      { agentId: "pm-initech", message: "anything" },
      recipes,
      refs,
    )
    expect(result.unresolvedIds).toContain("initech.does.not.exist")
  })

  it("is deterministic — same input → same card order", async () => {
    const refs = await loadReferences(tmp)
    const recipes = await loadRecipes(tmp)
    const a = resolveRecipes(
      { agentId: "devops-agent", message: "ssh in and restart" },
      recipes,
      refs,
    )
    const b = resolveRecipes(
      { agentId: "devops-agent", message: "ssh in and restart" },
      recipes,
      refs,
    )
    expect(a.cards.map(c => c.id)).toEqual(b.cards.map(c => c.id))
  })
})
