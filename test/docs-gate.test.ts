import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
// @ts-expect-error plain ESM script without type declarations
import * as lib from "../scripts/docs-gate-lib.mjs"

const config = JSON.parse(readFileSync(new URL("../scripts/docs-gate.config.json", import.meta.url), "utf8"))
const { applyBaseline, checkImpact, checkPage, coverageGaps, globToRegExp, keyPatterns, parseDiff, staleMentions, titleType } = lib

const GOOD_ENDING = "\n## Check it worked\n\nOpen the page.\n\n## If something is wrong\n\nRestart it.\n"

function diff(files: Array<{ path: string; status?: "added" | "deleted"; added?: string[]; removed?: string[] }>): string {
  return files
    .map((f) => {
      const head = [`diff --git a/${f.path} b/${f.path}`]
      if (f.status === "added") head.push("new file mode 100644")
      if (f.status === "deleted") head.push("deleted file mode 100644")
      head.push(`--- a/${f.path}`, `+++ b/${f.path}`, "@@ -1,1 +1,1 @@")
      return [...head, ...(f.removed ?? []).map((l) => `-${l}`), ...(f.added ?? []).map((l) => `+${l}`)].join("\n")
    })
    .join("\n")
}

const pr = (over: Partial<{ title: string; body: string; labels: string[] }> = {}) => ({
  title: "feat(cli): add a flag",
  body: "",
  labels: [],
  ...over,
})

const surface = (commands: Array<{ path: string; flags?: string[] }>, configKeys: string[] = []) => ({
  binName: "agentx",
  commands: commands.map((c) => ({ path: c.path, flags: c.flags ?? [], hidden: false })),
  configKeys,
})

describe("globToRegExp", () => {
  it("matches ** across directories and * within one segment", () => {
    expect(globToRegExp("src/commands/**").test("src/commands/a/b.ts")).toBe(true)
    expect(globToRegExp("**/*.test.ts").test("test/x.test.ts")).toBe(true)
    expect(globToRegExp("**/*.test.ts").test("x.test.ts")).toBe(true)
    expect(globToRegExp("docs/*.md").test("docs/a/b.md")).toBe(false)
  })
})

describe("parseDiff", () => {
  it("reads status and added/removed lines with line numbers", () => {
    const files = parseDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -3,1 +3,2 @@",
        "-old",
        "+new",
        "+more",
        "diff --git a/b.md b/b.md",
        "deleted file mode 100644",
      ].join("\n"),
    )
    expect(files[0]).toMatchObject({ path: "a.ts", status: "modified" })
    expect(files[0].added).toEqual([{ line: 3, text: "new" }, { line: 4, text: "more" }])
    expect(files[0].removed).toEqual([{ line: 3, text: "old" }])
    expect(files[1]).toMatchObject({ path: "b.md", status: "deleted" })
  })
})

describe("titleType", () => {
  it("reads the conventional-commit type", () => {
    expect(titleType("refactor(daemon)!: x")).toBe("refactor")
    expect(titleType("Add things")).toBe("")
  })
})

describe("checkImpact", () => {
  const run = (files: string, prOver = {}, base = null, head = null, pages: Array<{ path: string; text: string }> = []) =>
    checkImpact({ files: parseDiff(files), pr: pr(prOver), config, base, head, pages })

  it("fails a user-facing change with no docs, and names the changed file", () => {
    const { errors } = run(diff([{ path: "src/commands/run.ts", added: ["x"] }]))
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("src/commands/run.ts")
    expect(errors[0].message).toContain("no-docs-needed")
  })

  it("passes once a docs page changes in the same PR", () => {
    const { errors } = run(diff([{ path: "src/commands/run.ts" }, { path: "docs/reference/cli.md", added: ["x"] }]))
    expect(errors).toEqual([])
  })

  it("does not count a screenshot or a deleted page as a docs change", () => {
    const { errors } = run(
      diff([{ path: "src/commands/run.ts" }, { path: "docs/public/a.png" }, { path: "docs/old.md", status: "deleted" }]),
    )
    expect(errors).toHaveLength(1)
  })

  it("ignores tests, CI and internal code", () => {
    const { errors, notes } = run(
      diff([{ path: "test/a.test.ts" }, { path: ".github/workflows/ci.yml" }, { path: "src/daemon/runtime.ts", added: ["const a = 1"] }]),
    )
    expect(errors).toEqual([])
    expect(notes.join(" ")).toContain("No user-facing change")
  })

  it("treats a new environment variable as user-facing", () => {
    const { errors } = run(diff([{ path: "src/daemon/runtime.ts", added: ["const v = process.env.AGENTX_NEW_THING"] }]))
    expect(errors[0].message).toContain("AGENTX_NEW_THING")
  })

  it("does not flag an environment variable that only moved", () => {
    const line = "const v = process.env.AGENTX_OLD_THING"
    const { errors } = run(diff([{ path: "src/daemon/runtime.ts", added: [line], removed: [line] }]))
    expect(errors).toEqual([])
  })

  it("accepts the label with a reason line", () => {
    const { errors, notes } = run(diff([{ path: "src/commands/run.ts" }]), {
      labels: ["no-docs-needed"],
      body: "Some text\nDocs: not needed because the help text only changed wording\n",
    })
    expect(errors).toEqual([])
    expect(notes.join(" ")).toContain("help text only changed wording")
  })

  it("rejects the label without a reason, and a reason without the label", () => {
    expect(run(diff([{ path: "src/commands/run.ts" }]), { labels: ["no-docs-needed"] }).errors[0].message).toContain(
      "needs a reason",
    )
    expect(
      run(diff([{ path: "src/commands/run.ts" }]), { body: "Docs: not needed because reasons" }).errors,
    ).toHaveLength(1)
  })

  it("does not read the reason from the PR template's comment", () => {
    const body = "<!-- hint:\nDocs: not needed because <your reason>\n-->\r\n"
    expect(run(diff([{ path: "src/commands/run.ts" }]), { labels: ["no-docs-needed"], body }).errors).toHaveLength(1)
    expect(
      run(diff([{ path: "src/commands/run.ts" }]), { labels: ["no-docs-needed"], body: `${body}Docs: not needed because typo fix\r\n` })
        .errors,
    ).toEqual([])
  })

  it("lets refactor and test PRs through by title", () => {
    expect(run(diff([{ path: "src/commands/run.ts" }]), { title: "refactor(cli): split run" }).errors).toEqual([])
  })

  it("fails a removed command still mentioned in docs, even when exempt", () => {
    const base = surface([{ path: "run" }, { path: "gone" }])
    const head = surface([{ path: "run" }])
    const pages = [{ path: "docs/reference/cli.md", text: "# CLI\n\nUse `agentx gone` to stop.\n" }]
    const { errors } = run(diff([{ path: "src/commands/gone.ts", status: "deleted" }]), { title: "refactor: drop gone" }, base, head, pages)
    expect(errors).toEqual([
      { file: "docs/reference/cli.md", line: 3, message: 'Command "agentx gone" was removed but is still mentioned here' },
    ])
  })

  it("notes when the removal check could not run", () => {
    expect(run(diff([])).notes.join(" ")).toContain("Removal check skipped")
  })
})

describe("staleMentions", () => {
  it("finds a removed flag only on pages about that command", () => {
    const base = surface([{ path: "run", flags: ["--fast"] }, { path: "other", flags: ["--fast"] }])
    const head = surface([{ path: "run" }, { path: "other", flags: ["--fast"] }])
    const pages = [
      { path: "docs/run.md", text: "agentx run --fast" },
      { path: "docs/other.md", text: "agentx other --fast" },
    ]
    expect(staleMentions(base, head, pages).map((e: { file: string }) => e.file)).toEqual(["docs/run.md"])
  })

  it("finds a removed setting by its dotted path", () => {
    const base = surface([], ["daemon.port", "daemon.oldKnob"])
    const head = surface([], ["daemon.port"])
    const pages = [{ path: "docs/config.md", text: 'Set `daemon.oldKnob` to 3.\n\n```json\n{ "port": 1 }\n```' }]
    const found = staleMentions(base, head, pages)
    expect(found).toHaveLength(1)
    expect(found[0].message).toContain("daemon.oldKnob")
  })
})

describe("keyPatterns", () => {
  it("uses the part after the last wildcard", () => {
    const res = keyPatterns("agents.*.voice.id", { leafOk: false })
    expect(res.some((r: RegExp) => r.test("set voice.id here"))).toBe(true)
  })
})

describe("coverageGaps", () => {
  it("lists commands, flags and settings missing from docs", () => {
    const s = surface([{ path: "run", flags: ["--fast", "--help"] }, { path: "hidden" }], ["daemon.port", "daemon.secret"])
    const pages = [{ path: "docs/a.md", text: "agentx run --fast and `daemon.port`" }]
    expect(coverageGaps(s, pages, config.coverage)).toEqual(["command: agentx hidden", "setting: daemon.secret"])
  })
})

describe("checkPage", () => {
  const rules = { ...config.rules }
  const check = (text: string, exists = () => true) => checkPage("docs/guide/page.md", text, rules, exists)

  it("passes a page that ends with both sections", () => {
    expect(check(`# Page\n\nIntro.${GOOD_ENDING}`)).toEqual([])
  })

  it("reports each missing ending section", () => {
    const errors = check("# Page\n\nIntro.\n")
    expect(errors).toHaveLength(2)
    expect(errors.every((e: { kind: string }) => e.kind === "structure")).toBe(true)
  })

  it("reports sections in the wrong order, and a section after the last one", () => {
    expect(check("# P\n## If something is wrong\n\nx\n## Check it worked\n\ny\n")[0].message).toContain("order")
    expect(check(`# P${GOOD_ENDING}\n## Extra\n\nz\n`)[0].message).toContain("must be the last section")
  })

  it("allows subsections inside the last section", () => {
    expect(check(`# P${GOOD_ENDING}\n### It will not start\n\nz\n`)).toEqual([])
  })

  it("ignores headings inside code fences", () => {
    expect(check("# P\n\n```md\n## Check it worked\n## If something is wrong\n```\n")).toHaveLength(2)
  })

  it("asks for numbered steps when bullets read as actions", () => {
    const errors = check(`# P\n\n- Open the dashboard.\n- Click Save.\n${GOOD_ENDING}`)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ line: 3, kind: "structure" })
  })

  it("leaves ordinary bullet lists alone", () => {
    expect(check(`# P\n\n- A fast model.\n- A cheap model.\n${GOOD_ENDING}`)).toEqual([])
  })

  it("reports a missing image, resolving / to the public folder", () => {
    const seen: string[] = []
    const errors = check(`# P\n\n![Shot](/screenshots/p/a.png)\n![Rel](../img/b.png)\n${GOOD_ENDING}`, ((p: string) => {
      seen.push(p)
      return false
    }) as () => boolean)
    expect(seen).toEqual(["docs/public/screenshots/p/a.png", "docs/img/b.png"])
    expect(errors.map((e: { kind: string }) => e.kind)).toEqual(["content", "content"])
  })

  it("reports tokens and home paths, also inside code", () => {
    const errors = check(`# P\n\n\`\`\`sh\ncd /Users/someone/project\n\`\`\`\n${GOOD_ENDING}`)
    expect(errors).toEqual([expect.objectContaining({ line: 4, kind: "content" })])
  })

  it("allows the /Users/you/ and /home/you/ placeholders", () => {
    expect(check(`# P\n\nType \`/Users/you/a.png\` or \`/home/you/a.png\`.\n${GOOD_ENDING}`)).toEqual([])
  })
})

describe("applyBaseline", () => {
  const structure = { file: "docs/old.md", line: 0, message: "Missing", kind: "structure" }
  const content = { file: "docs/old.md", line: 4, message: "Not allowed", kind: "content" }

  it("turns structure problems on baseline pages into warnings", () => {
    expect(applyBaseline("docs/old.md", [structure, content], ["docs/old.md"])).toEqual({
      errors: [content],
      warnings: [structure],
    })
  })

  it("keeps every problem an error on pages not on the baseline", () => {
    expect(applyBaseline("docs/new.md", [structure], ["docs/old.md"])).toEqual({ errors: [structure], warnings: [] })
  })

  it("asks to remove a fixed page from the baseline", () => {
    const { errors } = applyBaseline("docs/old.md", [], ["docs/old.md"])
    expect(errors[0].message).toContain("Remove \"docs/old.md\" from rules.baseline")
  })
})

describe("docs-gate.config.json", () => {
  it("compiles every pattern", () => {
    for (const f of config.rules.forbidden) expect(() => new RegExp(f.pattern)).not.toThrow()
    for (const p of config.surface.addedLinePatterns) expect(() => new RegExp(p.pattern)).not.toThrow()
    expect(() => new RegExp(config.exempt.reasonPattern)).not.toThrow()
  })

  it("lists only baseline pages that exist", () => {
    for (const p of config.rules.baseline) expect(existsSync(new URL(`../${p}`, import.meta.url)), p).toBe(true)
  })
})
