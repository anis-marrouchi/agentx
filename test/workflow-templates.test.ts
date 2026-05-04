import { describe, it, expect } from "vitest"
import { TEMPLATES, readTemplate } from "../src/workflows/templates"
import { parseYamlWorkflow } from "../src/workflows/yaml"
import { workflowSchema, lintWorkflow } from "../src/workflows/types"

// Round-trips every shipped template through the same pipeline `agentx
// workflow init` runs: load YAML → substitute placeholders → parseYaml
// → schema → lint. If any of these fail, `init` would emit a broken
// scaffold — the operator would then have to patch the YAML before
// validate passes, which defeats the whole "type four commands and
// you have a workflow" promise of the typed-DSL feature.

function instantiate(text: string, id: string): string {
  return text
    .replace(/__ID__/g, id)
    .replace(/__TITLE__/g, `${id} (test)`)
    .replace(/__AGENT__/g, "test-agent")
    .replace(/__REVIEWER__/g, "alice")
}

describe("workflow templates", () => {
  it("ships exactly the documented set", () => {
    const names = TEMPLATES.map((t) => t.name).sort()
    expect(names).toEqual(["branching", "extract", "human-in-the-loop", "linear", "retry"])
  })

  it.each(TEMPLATES)("template '$name' round-trips through parse → schema → lint clean", ({ name }) => {
    const raw = instantiate(readTemplate(name), name)
    const parsed = workflowSchema.safeParse(parseYamlWorkflow(raw, { filePath: `${name}.yaml` }))
    if (!parsed.success) {
      const summary = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("\n  ")
      throw new Error(`schema rejected template "${name}":\n  ${summary}`)
    }
    const issues = lintWorkflow(parsed.data)
    if (issues.length > 0) {
      throw new Error(`lint flagged template "${name}": ${issues.join(" | ")}`)
    }
    expect(parsed.data.id).toBe(name)
  })

  it("readTemplate throws a useful error for an unknown name", () => {
    expect(() => readTemplate("nope" as any)).toThrowError(/template "nope" not found/i)
  })
})
