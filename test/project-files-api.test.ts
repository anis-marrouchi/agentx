import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cachedProjectRoot, findProjectRoot, gitRootOf, ROOT_TTL_MS, projectName, projectRootOf, readProject } from "../src/daemon/project-files-api"

// The Hub's Project tab (#2455): the Git repo an agent works in, found from
// its runs' files, listed read only without dot names.
let home = ""
let repo = ""
let other = ""
let ws = ""
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "ax-project-"))
  repo = join(home, "code", "app")
  other = join(home, "code", "lib")
  ws = join(home, "agents", "coder")
  for (const d of [join(repo, ".git"), join(repo, "src"), join(repo, ".github"), join(other, "src"), ws]) mkdirSync(d, { recursive: true })
  writeFileSync(join(other, ".git"), "gitdir: /elsewhere\n") // a worktree's .git is a file
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1\n")
  writeFileSync(join(repo, ".eslintrc"), "{}")
  writeFileSync(join(repo, "README.md"), "# app\n")
  writeFileSync(join(repo, ".env"), "SECRET=1")
  symlinkSync(join(repo, ".github"), join(repo, "gh-link"))
})
afterAll(() => { rmSync(home, { recursive: true, force: true }) })

const tx = (...paths: string[]) => paths.map((p) => `→ Edit({"file_path":"${p}","old_string":"a","new_string":"b"})`).join("\n")

describe("the project a run works in", () => {
  it("the nearest folder with a .git, a clone or a worktree; never home", () => {
    expect(gitRootOf(join(repo, "src"), home)).toBe(repo)
    expect(gitRootOf(join(other, "src"), home)).toBe(other)
    expect(gitRootOf(ws, home)).toBeNull()
    // home itself holds a .git: still no project.
    mkdirSync(join(home, ".git"))
    expect(gitRootOf(ws, home)).toBeNull()
    rmSync(join(home, ".git"), { recursive: true })
  })
  it("never a repo inside a dot folder, or outside home (#2460 B1)", () => {
    const hidden = join(home, ".x", "repo")
    mkdirSync(join(hidden, ".git"), { recursive: true })
    mkdirSync(join(hidden, "src"))
    expect(gitRootOf(join(hidden, "src"), home)).toBeNull()
    expect(projectRootOf([join(hidden, "src/a.ts"), join(repo, "README.md")], ws, "/", home)).toBe(repo)
    const outside = mkdtempSync(join(tmpdir(), "ax-project-out-"))
    try {
      mkdirSync(join(outside, ".git"))
      mkdirSync(join(outside, "src"))
      expect(gitRootOf(join(outside, "src"), home)).toBeNull()
      expect(projectRootOf([join(outside, "src/a.ts")], ws, "/", home)).toBeNull()
    } finally { rmSync(outside, { recursive: true, force: true }) }
    rmSync(join(home, ".x"), { recursive: true })
  })
  it("AgentX's own task worktrees are a project; other dot folders are not (#2460 B2)", () => {
    const wt = join(home, "code", ".agentx-worktrees", "app", "branch-x")
    mkdirSync(join(wt, "src"), { recursive: true })
    writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n")
    const hidden = join(home, ".x", "repo")
    mkdirSync(join(hidden, ".git"), { recursive: true })
    try {
      expect(gitRootOf(join(wt, "src"), home)).toBe(wt)
      expect(gitRootOf(hidden, home)).toBeNull()
      // A configured worktrees root (worktrees.root), outside home: its repos count, dot folders below it do not.
      const top = mkdtempSync(join(tmpdir(), "ax-project-wt-"))
      try {
        mkdirSync(join(top, "issue-1", ".git"), { recursive: true })
        mkdirSync(join(top, ".y", "issue-2", ".git"), { recursive: true })
        expect(gitRootOf(join(top, "issue-1"), home)).toBeNull()
        expect(gitRootOf(join(top, "issue-1"), home, [top])).toBe(join(top, "issue-1"))
        expect(gitRootOf(join(top, ".y", "issue-2"), home, [top])).toBeNull()
        // A root at or above home opens nothing more.
        expect(gitRootOf(hidden, home, ["/"])).toBeNull()
        expect(gitRootOf(hidden, home, [home])).toBeNull()
      } finally { rmSync(top, { recursive: true, force: true }) }
    } finally { rmSync(join(home, "code", ".agentx-worktrees"), { recursive: true }); rmSync(join(home, ".x"), { recursive: true }) }
  })
  it("reads the run's record once, and keeps the root for a while (#2460 C1)", () => {
    let reads = 0
    const runs = { record: (id: string) => { reads++; return id === "r1" ? { transcript: tx(join(repo, "src/a.ts")) } : null }, recent: () => [] }
    expect(findProjectRoot(ws, "r1", runs, "/", home)).toBe(repo)
    expect(reads).toBe(1)
    let finds = 0
    const find = () => { finds++; return repo }
    expect(cachedProjectRoot("a\0r1", find, 1_000)).toBe(repo)
    expect(cachedProjectRoot("a\0r1", find, 1_000 + ROOT_TTL_MS - 1)).toBe(repo)
    expect(finds).toBe(1)
    expect(cachedProjectRoot("a\0r1", find, 1_000 + ROOT_TTL_MS)).toBe(repo)
    expect(finds).toBe(2)
  })
  it("the repo most of the run's files sit in; relative paths are the workspace's", () => {
    expect(projectRootOf([join(repo, "src/a.ts"), join(repo, "README.md"), join(other, "src/x.ts")], ws, "/", home)).toBe(repo)
    expect(projectRootOf(["notes.md"], ws, "/", home)).toBeNull()
    expect(projectRootOf([], ws, "/", home)).toBeNull()
  })
  it("the run's record first, else the agent's newest runs (a run still going has no record), else none", () => {
    const records: Record<string, { transcript: string }> = { done1: { transcript: tx(join(other, "src/x.ts")) }, old: { transcript: tx(join(repo, "src/a.ts")) } }
    const runs = { record: (id: string) => records[id] ?? null, recent: () => ["old"] }
    expect(findProjectRoot(ws, "done1", runs, "/", home)).toBe(other)
    expect(findProjectRoot(ws, "live", runs, "/", home)).toBe(repo)
    expect(findProjectRoot(ws, "", { record: () => null, recent: () => [] }, "/", home)).toBeNull()
  })
})

describe("reading the project", () => {
  it("no repo: none, so the tab is hidden", () => {
    expect(readProject(null, "")).toEqual({ ok: true, kind: "none" })
  })
  it("lists without dot names or secrets, and reads a text file", () => {
    const top = readProject(repo, "")
    expect(top.ok && top.kind === "dir" ? top.entries.map((e) => e.name) : top).toEqual(["src", "README.md"])
    const f = readProject(repo, "src/a.ts")
    expect(f.ok && f.kind === "file" ? f.content : f).toBe("export const a = 1\n")
    expect(projectName(repo)).toBe("app")
  })
  it("refuses a dot path, a link to a dot folder, and a path out of the repo", () => {
    expect(readProject(repo, ".github")).toMatchObject({ ok: false, status: 403 })
    expect(readProject(repo, ".eslintrc")).toMatchObject({ ok: false, status: 403 })
    expect(readProject(repo, "gh-link")).toMatchObject({ ok: false, status: 403 })
    expect(readProject(repo, "../lib")).toMatchObject({ ok: false, status: 403 })
    expect(readProject(repo, ".env")).toMatchObject({ ok: false })
  })
})
