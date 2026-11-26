import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { attachedOf, fileOpOf, filesTabHtml, mergeRunFiles, runFileHtml, runFilesOf, wflIcon, WALL_FILES_CSS, workspaceFileHtml, workspaceHtml, workspaceRel } from "../src/daemon/ui/pages/wall-files"
import { isHiddenName, readWorkspace, WORKSPACE_FILE_MAX, workspaceParts } from "../src/daemon/workspace-files-api"

// #2101 R17: the right panel's Files tab. What a run or a chat touched,
// read from the run's record (its transcript's `→ Tool({json})` lines and
// its answer's artifact tags) and the chat's "Attached:" lines.

const call = (name: string, input: unknown) => `→ ${name}(${typeof input === "string" ? input : JSON.stringify(input)})`

describe("Files tab: reading a run (#2101 R17)", () => {
  it("knows the file tools", () => {
    expect(fileOpOf("Read")).toBe("read")
    expect(fileOpOf("Edit")).toBe("edited")
    expect(fileOpOf("MultiEdit")).toBe("edited")
    expect(fileOpOf("Write")).toBe("wrote")
    expect(fileOpOf("create_files")).toBe("wrote")
    expect(fileOpOf("Bash")).toBeNull()
    expect(fileOpOf("")).toBeNull()
  })

  it("lists each file once, by the strongest thing done to it, changed ones first", () => {
    const tx = [
      "▸ init model=claude",
      call("Read", { file_path: "src/app.ts" }),
      "← const a = 1",
      call("Bash", { command: "ls" }),
      call("Edit", { file_path: "src/app.ts", old_string: "const a = 1", new_string: "const a = 2" }),
      call("Read", { file_path: "README.md" }),
      call("Write", { file_path: "docs/new.md", content: "# New\nHello" }),
      "Done.",
    ].join("\n")
    const r = runFilesOf(tx, "")
    expect(r.files.map((f) => [f.path, f.op, f.n])).toEqual([
      ["docs/new.md", "wrote", 1],
      ["src/app.ts", "edited", 2],
      ["README.md", "read", 1],
    ])
    expect(r.files[0].changes).toEqual([{ before: "", after: "# New\nHello", isNew: true }])
    expect(r.files[1].changes).toEqual([{ before: "const a = 1", after: "const a = 2", isNew: false }])
    expect(r.files[2].changes).toEqual([])
  })

  it("keeps the path of a call whose input the log clipped, without its content", () => {
    const clipped = `{"file_path":"src/very/long.ts","old_string":"${"x".repeat(50)}…`
    const r = runFilesOf(call("Edit", clipped), "")
    expect(r.files).toEqual([{ path: "src/very/long.ts", op: "edited", n: 1, changes: [] }])
    expect(runFileHtml(r.files[0])).toContain("The change was too long to keep in the run's log.")
  })

  it("reads MultiEdit's edits, create_files' files and a Codex file change", () => {
    const tx = [
      call("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "4" }] }),
      call("create_files", { files: [{ path: "b.ts", content: "b" }, { path: "c.ts", content: "c" }] }),
      call("Edit", { path: "codex/d.ts" }),
    ].join("\n")
    const r = runFilesOf(tx, "")
    expect(r.files.map((f) => f.path)).toEqual(["b.ts", "c.ts", "a.ts", "codex/d.ts"])
    expect(r.files[2].changes[0]).toEqual({ before: "1\n⋯\n3", after: "2\n⋯\n4", isNew: false })
  })

  it("lists the answer's artifacts and skips a broken tag", () => {
    const answer = 'Here.<agentx-artifact>{"filename":"report.pdf","mime":"application/pdf"}</agentx-artifact><agentx-artifact>{oops</agentx-artifact>'
    expect(runFilesOf("", answer).artifacts).toEqual([{ filename: "report.pdf", mime: "application/pdf" }])
  })

  it("reads the files a message carried from its Attached line", () => {
    expect(attachedOf(["Look at this\n\nAttached: shot.png, notes.pdf", "No files", "Again\n\nAttached: shot.png"])).toEqual(["shot.png", "notes.pdf"])
    expect(attachedOf([])).toEqual([])
  })

  it("adds several runs up into one list, as a chat has", () => {
    const a = runFilesOf(call("Read", { file_path: "x.ts" }), "")
    const b = runFilesOf(call("Edit", { file_path: "x.ts", old_string: "a", new_string: "b" }), '<agentx-artifact>{"filename":"o.csv"}</agentx-artifact>')
    const m = mergeRunFiles([a, b, { files: [], artifacts: [{ filename: "o.csv", mime: "" }], attached: ["in.png"] }])
    expect(m.files).toEqual([{ path: "x.ts", op: "edited", n: 2, changes: [{ before: "a", after: "b", isNew: false }] }])
    expect(m.artifacts).toEqual([{ filename: "o.csv", mime: "" }])
    expect(m.attached).toEqual(["in.png"])
  })
})

describe("Files tab: what it draws (#2101 R17)", () => {
  const r = mergeRunFiles([
    runFilesOf([call("Edit", { file_path: "src/<app>.ts", old_string: "a", new_string: "b" }), call("Read", { file_path: "README.md" })].join("\n"),
      '<agentx-artifact>{"filename":"report.pdf","mime":"application/pdf"}</agentx-artifact>'),
    { files: [], artifacts: [], attached: ["shot.png"] },
  ])

  it("draws changed, read, sent and attached rows, each with its icon, and the PR first", () => {
    const html = filesTabHtml(r, { key: "task:n|cx|t1", changes: { id: "r1", ref: "acme/shop#12" } })
    expect(html).toContain('<p class="wcx__at">1 changed · 1 read · 1 sent · 1 attached</p>')
    expect(html.indexOf('data-kind="changes" data-id="r1"')).toBeLessThan(html.indexOf('data-cx="wfile"'))
    expect(html).toContain('data-cx="wfile" data-src="task:n|cx|t1" data-i="0" title="src/&lt;app&gt;.ts"><span class="wfl__op is-edited"><svg class="wfl__ic"')
    expect(html).toContain("edited</span><b>&lt;app&gt;.ts</b><small>src</small>")
    expect(html).toContain('data-i="1" title="README.md"')
    expect(html).toContain("<b>report.pdf</b><small>application/pdf · sent with the answer</small>")
    expect(html).toContain("<b>shot.png</b><small>you attached it</small>")
    expect(html).not.toContain("<script")
  })

  it("says so when nothing was touched", () => {
    expect(filesTabHtml({ files: [], artifacts: [], attached: [] }, { key: "k" })).toContain("No files yet")
  })

  it("shows one file's changes as removed and added lines", () => {
    const html = runFileHtml(r.files[0])
    expect(html).toContain("<code>src/&lt;app&gt;.ts</code> · edited")
    expect(html).toContain('<tr class="is-del"><td class="wdf__c">a</td></tr><tr class="is-add"><td class="wdf__c">b</td></tr>')
    expect(runFileHtml(r.files[1])).toContain("Read by the run. Its log keeps the path, not the content.")
    expect(runFileHtml(undefined)).toContain("not in the list any more")
  })

  it("has line icons and motion that stops under reduced motion (U1)", () => {
    expect(wflIcon("read")).toContain('stroke="currentColor"')
    expect(wflIcon("nope")).toBe(wflIcon("files"))
    expect(WALL_FILES_CSS).toContain("@keyframes wfl-in")
    expect(WALL_FILES_CSS).toContain("prefers-reduced-motion: reduce")
  })
})

// #2101 R17: the agent's workspace, read only, never outside it.
describe("Workspace files: reading inside the workspace only (#2101 R17)", () => {
  let base: string, ws: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "agentx-ws-"))
    ws = join(base, "ws")
    mkdirSync(join(ws, "src", "deep"), { recursive: true })
    mkdirSync(join(ws, ".git"))
    mkdirSync(join(ws, "node_modules"))
    writeFileSync(join(ws, "README.md"), "# Hello\nworld")
    writeFileSync(join(ws, "src", "a.ts"), "export const a = 1\n")
    writeFileSync(join(ws, ".env"), "SECRET=1")
    writeFileSync(join(ws, "server.pem"), "key")
    writeFileSync(join(ws, "bin.dat"), Buffer.from([1, 2, 0, 3]))
    writeFileSync(join(ws, "big.txt"), "x".repeat(WORKSPACE_FILE_MAX + 1))
    writeFileSync(join(base, "outside.txt"), "not yours")
    mkdirSync(join(base, "elsewhere"))
    writeFileSync(join(base, "elsewhere", "x.txt"), "not yours")
    symlinkSync(join(base, "outside.txt"), join(ws, "leak.txt"))
    symlinkSync(join(base, "elsewhere"), join(ws, "leakdir"))
    symlinkSync(join(ws, "src", "a.ts"), join(ws, "alias.ts"))
    symlinkSync(join(ws, ".env"), join(ws, "env-link"))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it("lists the top folder: folders first, no .git, node_modules, secrets or links that lead out", () => {
    const r = readWorkspace(ws, "")
    expect(r.ok).toBe(true)
    if (!r.ok || r.kind !== "dir") throw new Error("not a dir")
    expect(r.root).toBe(realpathSync(ws))
    expect(r.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      "dir:src", "file:alias.ts", "file:big.txt", "file:bin.dat", "file:README.md",
    ])
    expect(r.entries.find((e) => e.name === "README.md")!.size).toBe(13)
  })

  it("lists a sub-folder and reads a text file", () => {
    const d = readWorkspace(ws, "src")
    expect(d.ok && d.kind === "dir" && d.entries.map((e) => e.name)).toEqual(["deep", "a.ts"])
    const f = readWorkspace(ws, "src/a.ts")
    expect(f).toMatchObject({ ok: true, kind: "file", path: "src/a.ts", content: "export const a = 1\n" })
    // A link that stays inside reads as its target.
    expect(readWorkspace(ws, "alias.ts")).toMatchObject({ ok: true, kind: "file", content: "export const a = 1\n" })
    expect(readWorkspace(ws, "./src//a.ts")).toMatchObject({ ok: true, path: "src/a.ts" })
  })

  it("refuses .., absolute paths, ~ and NUL", () => {
    expect(readWorkspace(ws, "../outside.txt")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, "src/../../outside.txt")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, "src\\..\\..\\outside.txt")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, join(base, "outside.txt"))).toMatchObject({ ok: false, status: 400 })
    expect(readWorkspace(ws, "/etc/passwd")).toMatchObject({ ok: false, status: 400 })
    expect(readWorkspace(ws, "C:\\Windows")).toMatchObject({ ok: false, status: 400 })
    expect(readWorkspace(ws, "~/.ssh/id_rsa")).toMatchObject({ ok: false, status: 400 })
    expect(readWorkspace(ws, "README.md\0")).toMatchObject({ ok: false, status: 400 })
  })

  it("refuses a link that leads out of the workspace, to a file or a folder", () => {
    expect(readWorkspace(ws, "leak.txt")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, "leakdir")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, "leakdir/x.txt")).toMatchObject({ ok: false, status: 403 })
  })

  it("never reads what usually holds secrets, by name or through a link", () => {
    expect(readWorkspace(ws, ".env")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, "server.pem")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, ".git/config")).toMatchObject({ ok: false, status: 403 })
    expect(readWorkspace(ws, "env-link")).toMatchObject({ ok: false, status: 403 })
    for (const n of [".env.local", "id_ed25519", "credentials.json", "secrets.yaml", "tokens.json", ".npmrc"]) expect(isHiddenName(n)).toBe(true)
    for (const n of ["README.md", "env.ts", "token-store.ts", "src"]) expect(isHiddenName(n)).toBe(false)
  })

  it("caps the size and refuses binary files", () => {
    expect(readWorkspace(ws, "big.txt")).toMatchObject({ ok: false, status: 413 })
    expect(readWorkspace(ws, "bin.dat")).toMatchObject({ ok: false, status: 415 })
    expect(readWorkspace(ws, "nope.txt")).toMatchObject({ ok: false, status: 404 })
  })

  it("says so for a missing workspace or none", () => {
    expect(readWorkspace(join(base, "gone"), "")).toMatchObject({ ok: false, status: 404 })
    expect(readWorkspace("", "")).toMatchObject({ ok: false, status: 404 })
  })

  it("resolves a relative workspace against the daemon's folder", () => {
    expect(readWorkspace("ws", "README.md", base)).toMatchObject({ ok: true, content: "# Hello\nworld" })
  })

  it("keeps the path parts as asked, or the reason", () => {
    expect(workspaceParts("")).toEqual([])
    expect(workspaceParts("a/./b/")).toEqual(["a", "b"])
    expect(workspaceParts("a/../b")).toEqual({ status: 403, error: "the path leaves the workspace" })
  })
})

describe("Workspace files: in the panel (#2101 R17)", () => {
  it("shows the folder in view with a path to climb, folders and files", () => {
    const html = workspaceHtml({ dir: "src/deep", loading: false, error: "", list: { root: "/w", more: false, entries: [{ name: "lib", kind: "dir", size: 0 }, { name: "a<b>.ts", kind: "file", size: 2048 }] } }, "chat:t1")
    expect(html).toContain('data-cx="wsdir" data-src="chat:t1" data-path="">workspace</button>')
    expect(html).toContain('data-cx="wsdir" data-src="chat:t1" data-path="src">src</button>')
    expect(html).toContain('data-cx="wsdir" data-src="chat:t1" data-path="src/deep/lib"')
    expect(html).toContain('data-cx="wsfile" data-src="chat:t1" data-path="src/deep/a&lt;b&gt;.ts"')
    expect(html).toContain("<b>a&lt;b&gt;.ts</b><small>2 KB</small>")
    expect(workspaceHtml(null, "k")).toBe("")
    expect(workspaceHtml({ dir: "", loading: true, error: "", list: null }, "k")).toContain("Reading the workspace…")
    expect(workspaceHtml({ dir: "", loading: false, error: "node down", list: null }, "k")).toContain("Workspace not available: node down.")
    expect(workspaceHtml({ dir: "", loading: false, error: "", list: { root: "/w", more: false, entries: [] } }, "k")).toContain("This folder is empty.")
  })

  it("shows a workspace file with its line numbers, escaped", () => {
    const html = workspaceFileHtml({ path: "src/a.ts", content: "a <b>\nc" })
    expect(html).toContain("<code>src/a.ts</code> · as it is now in the workspace")
    expect(html).toContain('<tr><td class="wdf__n">1</td><td class="wdf__c">a &lt;b&gt;</td></tr><tr><td class="wdf__n">2</td><td class="wdf__c">c</td></tr>')
    expect(workspaceFileHtml({ path: "x", error: "the file is too big" })).toContain("Not shown: the file is too big.")
    expect(workspaceFileHtml({ path: "x", loading: true })).toContain("Reading the file…")
  })

  it("maps a run's path into the workspace, or not", () => {
    expect(workspaceRel("/w/ws/src/a.ts", "/w/ws")).toBe("src/a.ts")
    expect(workspaceRel("/w/other/a.ts", "/w/ws")).toBeNull()
    expect(workspaceRel("/w/wsx/a.ts", "/w/ws")).toBeNull()
    expect(workspaceRel("./src/a.ts", "")).toBe("src/a.ts")
    expect(workspaceRel("../a.ts", "/w/ws")).toBeNull()
    expect(workspaceRel("", "/w/ws")).toBeNull()
  })
})
