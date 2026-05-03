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
    "references/ksi/ssh.yaml",
    [
      "namespace: ksi.ssh",
      "cards:",
      "  - id: clawd-mac",
      "    kind: ssh",
      "    summary: clawd-server",
      "    fields: { user: clawd, host: 64.226.102.124 }",
      "    tags: [deploy]",
      "  - id: ksi-server",
      "    kind: ssh",
      "    summary: KSI V1 production",
      "    fields: { user: root, host: 134.122.119.251 }",
      "    tags: [deploy, ksi-v1]",
    ].join("\n"),
  )
  write(
    "references/ksi/contacts.yaml",
    [
      "namespace: ksi.contacts",
      "cards:",
      "  - id: pm",
      "    kind: contact",
      "    summary: KSI PM",
      "    fields: { email: pm@ksi.tn }",
      "    tags: []",
      "  - id: dev",
      "    kind: contact",
      "    summary: KSI dev lead",
      "    fields: { email: dev@ksi.tn }",
      "    tags: []",
    ].join("\n"),
  )
  // Recipes
  write(
    "references/recipes/ksi.yaml",
    [
      "recipes:",
      "  - id: ksi-devops",
      "    when:",
      "      agentIds: [devops-agent, coder-agent]",
      "      messageRegex: ['deploy|ssh|server|restart']",
      "    references: [ksi.ssh.clawd-mac, ksi.ssh.ksi-server]",
      "    skills: [ksi-v2-deploy]",
      "  - id: ksi-cx",
      "    when:",
      "      agentIds: [cx-agent]",
      "      messageRegex: ['email|client|hotmail']",
      "    references: [ksi.contacts.*]",
      "    skills: [ksi-cx-email, hotmail]",
      "  - id: missing-ref",
      "    when:",
      "      agentIds: [pm-ksi]",
      "    references: [ksi.does.not.exist]",
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
    expect(result.matched.map(r => r.id)).toContain("ksi-devops")
    const ids = result.cards.map(c => c.id).sort()
    expect(ids).toEqual(["ksi.ssh.clawd-mac", "ksi.ssh.ksi-server"])
    expect(result.requiredSkills).toContain("ksi-v2-deploy")
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
    expect(ids).toEqual(["ksi.contacts.dev", "ksi.contacts.pm"])
    expect(result.requiredSkills.sort()).toEqual(["hotmail", "ksi-cx-email"])
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
      { agentId: "pm-ksi", message: "anything" },
      recipes,
      refs,
    )
    expect(result.unresolvedIds).toContain("ksi.does.not.exist")
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
