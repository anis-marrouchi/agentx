import { describe, expect, it } from "vitest"
import { capDiff, parseUnifiedDiff } from "../src/daemon/diff-parse"
import { unifiedDiff } from "../src/quality/review-gate-gitlab"

// #2102: the Hub's Diff view reads the PR/MR diff the review gate fetches.

const DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,4 @@ export function main() {",
  " const a = 1",
  "-const b = 2",
  "+const b = 3",
  " const c = 4",
  " const d = 5",
  "@@ -20,3 +20,4 @@",
  " x()",
  "+y()",
  "-- not a header, a deleted line",
  " z()",
  "\\ No newline at end of file",
  "diff --git a/docs/old.md b/docs/new.md",
  "similarity index 90%",
  "rename from docs/old.md",
  "rename to docs/new.md",
  "index 3333333..4444444 100644",
  "--- a/docs/old.md",
  "+++ b/docs/new.md",
  "@@ -2 +2 @@",
  "-old title",
  "+new title",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 0000000..5555555",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const one = 1",
  "+export const two = 2",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "index 6666666..0000000",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-export const gone = true",
  "diff --git a/img/logo.png b/img/logo.png",
  "index 7777777..8888888 100644",
  "Binary files a/img/logo.png and b/img/logo.png differ",
].join("\n")

describe("parseUnifiedDiff", () => {
  const files = parseUnifiedDiff(DIFF)

  it("reads every file with its status", () => {
    expect(files.map((f) => [f.file, f.status])).toEqual([
      ["src/app.ts", "modified"], ["docs/new.md", "renamed"], ["src/new.ts", "added"], ["src/gone.ts", "removed"], ["img/logo.png", "binary"],
    ])
  })

  it("numbers added, deleted and context lines on their own side", () => {
    const [first, second] = files[0].hunks
    expect(first.header).toBe("@@ -1,4 +1,4 @@ export function main() {")
    expect(first.lines).toEqual([
      { kind: "ctx", oldLine: 1, newLine: 1, text: "const a = 1" },
      { kind: "del", oldLine: 2, text: "const b = 2" },
      { kind: "add", newLine: 2, text: "const b = 3" },
      { kind: "ctx", oldLine: 3, newLine: 3, text: "const c = 4" },
      { kind: "ctx", oldLine: 4, newLine: 4, text: "const d = 5" },
    ])
    expect(second.lines).toEqual([
      { kind: "ctx", oldLine: 20, newLine: 20, text: "x()" },
      { kind: "add", newLine: 21, text: "y()" },
      { kind: "del", oldLine: 21, text: "- not a header, a deleted line" },
      { kind: "ctx", oldLine: 22, newLine: 22, text: "z()" },
    ])
  })

  it("keeps a renamed file's old path", () => {
    expect(files[1]).toMatchObject({ file: "docs/new.md", oldFile: "docs/old.md" })
    expect(files[1].hunks[0].lines).toEqual([{ kind: "del", oldLine: 2, text: "old title" }, { kind: "add", newLine: 2, text: "new title" }])
  })

  it("reads a new and a deleted file", () => {
    expect(files[2].oldFile).toBeUndefined()
    expect(files[2].hunks[0].lines.map((l) => l.newLine)).toEqual([1, 2])
    expect(files[3].hunks[0].lines).toEqual([{ kind: "del", oldLine: 1, text: "export const gone = true" }])
  })

  it("lists a binary file with no hunks", () => {
    expect(files[4]).toEqual({ file: "img/logo.png", status: "binary", hunks: [] })
  })

  it("ignores \"\\ No newline at end of file\"", () => {
    expect(files.flatMap((f) => f.hunks.flatMap((h) => h.lines)).some((l) => l.text.includes("No newline"))).toBe(false)
  })

  it("reads the diff the GitLab review gate builds", () => {
    const text = [
      unifiedDiff({ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }),
      unifiedDiff({ old_path: "b.ts", new_path: "b.ts", diff: "@@ -0,0 +1 @@\n+c\n", new_file: true }),
      unifiedDiff({ old_path: "c.ts", new_path: "d.ts", diff: "", renamed_file: true }),
    ].join("\n")
    expect(parseUnifiedDiff(text).map((f) => [f.file, f.status, f.oldFile])).toEqual([
      ["a.ts", "modified", undefined], ["b.ts", "added", undefined], ["d.ts", "renamed", "c.ts"],
    ])
  })

  it("reads a plain diff without git headers", () => {
    const plain = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-3\n+4"
    expect(parseUnifiedDiff(plain).map((f) => f.file)).toEqual(["x", "y"])
  })
})

describe("capDiff", () => {
  it("cuts file by file past the limit and marks what it cut", () => {
    const files = parseUnifiedDiff(DIFF)
    const { files: out, truncated } = capDiff(files, 10)
    expect(truncated).toBe(true)
    expect(out[0]).toBe(files[0])
    expect(out[1]).toMatchObject({ file: "docs/new.md", truncated: true })
    expect(out[1].hunks.flatMap((h) => h.lines)).toEqual([{ kind: "del", oldLine: 2, text: "old title" }])
    expect(out[2]).toMatchObject({ file: "src/new.ts", status: "added", hunks: [], truncated: true })
    expect(out[4]).toEqual({ file: "img/logo.png", status: "binary", hunks: [] })
  })

  it("leaves a small diff alone", () => {
    const files = parseUnifiedDiff(DIFF)
    expect(capDiff(files, 3000)).toEqual({ files, truncated: false })
  })
})
