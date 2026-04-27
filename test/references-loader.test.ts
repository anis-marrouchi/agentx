import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { loadReferences, renderReferences } from "../src/agents/references/loader"
import type { ReferenceCard } from "../src/agents/references/types"

let tmp: string

function write(rel: string, content: string) {
  const abs = path.join(tmp, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "refs-"))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("loadReferences", () => {
  it("loads YAML cards and namespaces them", async () => {
    write(
      "references/ksi/ssh.yaml",
      [
        "namespace: ksi.ssh",
        "cards:",
        "  - id: clawd-mac",
        "    kind: ssh",
        "    summary: clawd-server primary daemon host",
        "    fields:",
        "      user: clawd",
        "      host: 64.226.102.124",
        "      key: ~/.ssh/id_mac",
        "    tags: [clawd, agentx]",
      ].join("\n"),
    )
    const idx = await loadReferences(tmp)
    expect(idx.byId.has("ksi.ssh.clawd-mac")).toBe(true)
    const card = idx.byId.get("ksi.ssh.clawd-mac")!
    expect(card.fields.host).toBe("64.226.102.124")
    expect(idx.byTag.get("clawd")?.length).toBe(1)
  })

  it("rejects an invalid id", async () => {
    write(
      "references/bad/ids.yaml",
      [
        "cards:",
        "  - id: BadID!!",
        "    kind: ssh",
        "    summary: invalid",
        "    fields: { host: x }",
      ].join("\n"),
    )
    await expect(loadReferences(tmp)).resolves.toBeDefined()
    // file is logged + skipped, the earlier valid file should still load.
    const idx = await loadReferences(tmp)
    expect(idx.byId.has("ksi.ssh.clawd-mac")).toBe(true)
  })

  it("renders deterministically (alphabetical)", () => {
    const cards: ReferenceCard[] = [
      {
        id: "ksi.ssh.b",
        kind: "ssh",
        summary: "second",
        fields: { host: "2" },
        tags: [],
      },
      {
        id: "ksi.ssh.a",
        kind: "ssh",
        summary: "first",
        fields: { host: "1" },
        tags: [],
      },
    ]
    const out = renderReferences(cards)
    const aIdx = out.indexOf("ksi.ssh.a")
    const bIdx = out.indexOf("ksi.ssh.b")
    expect(aIdx).toBeGreaterThan(0)
    expect(bIdx).toBeGreaterThan(aIdx)
    expect(out.startsWith("[Verified References")).toBe(true)
  })

  it("trims by char budget", () => {
    const cards: ReferenceCard[] = Array.from({ length: 20 }, (_, i) => ({
      id: `ksi.test.${i.toString().padStart(2, "0")}`,
      kind: "ssh" as const,
      summary: "x".repeat(40),
      fields: { host: "h" },
      tags: [],
    }))
    const small = renderReferences(cards, 200)
    expect(small.length).toBeLessThanOrEqual(220)
    const big = renderReferences(cards, 5000)
    expect(big.length).toBeGreaterThan(small.length)
  })
})
