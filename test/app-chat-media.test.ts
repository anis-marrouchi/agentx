import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { markdownToHtml } from "../src/utils/markdown-html"
import { APP_ATTACH_HINT, ARTIFACT_LIMITS, artifactType, extractArtifacts } from "../src/utils/artifact-sentinel"
import { AppChatStore } from "../src/daemon/app-chat-store"
import { speakableAnswer } from "../src/daemon/voice-io-api"
import { buildAgentContext } from "../src/agents/context"
import { openDb, closeDb } from "../src/storage/sqlite"

// Pictures and files in phone chat answers (#253): the opt-in pictures of
// the shared markdown renderer, the <agentx-artifact> lines agents declare
// files with, their registration per conversation, and what is read out.

const pics = (html: string) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])

describe("markdown pictures, opted in", () => {
  const md = (s: string) => markdownToHtml(s, { images: 8 })

  it("renders web pictures with alt text, lazily and without a referrer", () => {
    const html = md("Here:\n\n![A chart](https://example.com/a.png) and ![](http://example.com/b.jpg?x=1&y=2)")
    expect(pics(html)).toEqual([
      '<img src="https://example.com/a.png" alt="A chart" loading="lazy" referrerpolicy="no-referrer">',
      '<img src="http://example.com/b.jpg?x=1&amp;y=2" alt="" loading="lazy" referrerpolicy="no-referrer">',
    ])
    expect(html).not.toContain("!<a")
  })

  it("shows at most the given number; the rest become links", () => {
    const text = [...Array(10)].map((_, i) => `![p${i}](https://example.com/${i}.png)`).join("\n\n")
    const html = md(text)
    expect(pics(html)).toHaveLength(8)
    expect(html).toContain('<a href="https://example.com/8.png" target="_blank" rel="noopener noreferrer">p8</a>')
    expect(pics(markdownToHtml(text, { images: 2 }))).toHaveLength(2)
    expect(pics(markdownToHtml(text, { images: true }))).toHaveLength(8)
  })

  it("keeps other schemes out: javascript:, data:, file: and relative addresses become their alt text", () => {
    for (const src of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:image/png;base64,AAAA", "data:text/html,<script>x()</script>", "file:///etc/passwd", "/app/icon.png", "//evil.example/x.png"]) {
      const html = md(`![boom](${src})`)
      expect(pics(html)).toEqual([])
      expect(html).not.toMatch(/javascript:|data:|file:/i)
      expect(html).toContain("boom")
    }
  })

  it("keeps hostile markup inert", () => {
    const cases = [
      '![x" onerror="alert(1)](https://example.com/a.png)',
      '![x](https://example.com/a.png" onerror="alert(1))',
      "![x](https://example.com/a.png'onerror='alert(1))",
      "![<script>alert(1)</script>](https://example.com/a.png)",
      "![a [b] c](https://example.com/a.png)",
      "![a](https://example.com/a.png)](javascript:alert(1))",
      "[![a](https://example.com/a.png)](javascript:alert(1))",
      "[link](http://example.com/x ![p](https://example.com/q.png) )",
      "[a](http://y/*b*) ![c*](https://example.com/*d*.png) *e*",
      "| ![a|b](https://example.com/a.png) | c |\n|---|---|\n| d | e |",
      "<img src=x onerror=alert(1)> ![ok](https://example.com/ok.png)",
      "`![code](https://example.com/c.png)` and\n```\n![fenced](https://example.com/f.png)\n```",
    ]
    for (const c of cases) {
      const html = md(c)
      // No attribute outside the ones the renderer writes, no raw tags.
      // Quoted values are text; what is left of each tag is its attribute names.
      for (const tag of html.match(/<[a-z][^>]*>/gi) ?? []) {
        expect(tag.replace(/"[^"]*"/g, '""')).not.toMatch(/\son[a-z]+\s*=/i)
      }
      expect(html).not.toContain("<script")
      // (Link addresses are the page's to filter, as before: the phone keeps
      // http(s) links only. A picture's address is checked here.)
      for (const img of pics(html)) {
        expect(img).toMatch(/^<img src="https?:\/\/[^"\s<>]+" alt="[^"<>]*" loading="lazy" referrerpolicy="no-referrer">$/)
      }
    }
    // Code stays code.
    expect(pics(md("`![code](https://example.com/c.png)`"))).toEqual([])
    expect(pics(md("```\n![fenced](https://example.com/f.png)\n```"))).toEqual([])
    // A picture inside a link's address is its alt text there, not markup.
    expect(md("[link](http://example.com/x ![p](https://example.com/q.png) )")).not.toContain("<img")
  })

  it("leaves every other caller as it was: a picture is still a link", () => {
    const text = "# T\n\n![A chart](https://example.com/a.png) **b** [c](https://example.com)"
    const plain = markdownToHtml(text)
    expect(plain).toBe(markdownToHtml(text, {}))
    expect(plain).toBe(markdownToHtml(text, { wikilink: (t) => t }))
    expect(plain).not.toContain("<img")
    expect(plain).toContain('!<a href="https://example.com/a.png" target="_blank" rel="noopener noreferrer">A chart</a>')
  })
})

describe("declared files: <agentx-artifact>", () => {
  it("strips every sentinel and returns the files in order", () => {
    const out = extractArtifacts('Done.\n<agentx-artifact>{"filename":"out/chart.png","mime":"image/png"}</agentx-artifact>\n<agentx-artifact>{"filename":"r.pdf","mime":"application/pdf"}</agentx-artifact>')
    expect(out.text).toBe("Done.")
    expect(out.artifacts).toEqual([
      { type: "image", filename: "out/chart.png", mime: "image/png" },
      { type: "pdf", filename: "r.pdf", mime: "application/pdf" },
    ])
  })

  it("drops malformed and half-written sentinels from the text too", () => {
    const out = extractArtifacts('A <agentx-artifact>not json</agentx-artifact> B <agentx-artifact>{"filename":"x.png"}</agentx-artifact> C <agentx-artifact>{"filena')
    expect(out.text).toBe("A  B  C")
    expect(out.artifacts).toEqual([])
  })

  it("keeps at most `max` files", () => {
    const many = [...Array(30)].map((_, i) => `<agentx-artifact>{"filename":"f${i}.png","mime":"image/png"}</agentx-artifact>`).join("")
    const out = extractArtifacts(many, ARTIFACT_LIMITS.perMessage)
    expect(out.artifacts).toHaveLength(20)
    expect(out.text).toBe("")
  })

  it("serves by extension from an allowlist; svg only downloads", () => {
    expect(artifactType("a/b.PNG")).toEqual({ mime: "image/png", kind: "image" })
    expect(artifactType("x.svg")?.kind).toBe("file")
    expect(artifactType("clip.webm")?.kind).toBe("video")
    expect(artifactType("note.m4a")?.kind).toBe("audio")
    for (const bad of ["page.html", "run.sh", ".env", "x.js", "noext"]) expect(artifactType(bad)).toBeNull()
  })
})

describe("registering declared files with the conversation", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentx-app-media-"))
  const store = new AppChatStore(openDb({ path: join(dir, "db.sqlite") })!)
  afterAll(() => { closeDb(); rmSync(dir, { recursive: true, force: true }) })

  it("gives each allowed file a random id only its phone can resolve", () => {
    const c = store.create("dev-1", { node: "local", nodeName: "n", agent: "alpha" }, "hi")
    const refs = store.appendWithFiles("dev-1", c.id, { role: "assistant", content: "ok", status: "done", at: 1 }, [
      { type: "image", filename: "charts/a.png", mime: "image/png" },
      { type: "file", filename: "page.html", mime: "text/html" },
      { type: "file", filename: "x".repeat(600) + ".png", mime: "image/png" },
      { type: "file", filename: "notes/r.pdf", mime: "application/pdf" },
    ])!
    expect(refs.map((r) => [r.name, r.kind, r.mime])).toEqual([["a.png", "image", "image/png"], ["r.pdf", "file", "application/pdf"]])
    for (const r of refs) expect(r.id).toMatch(/^[a-f0-9]{32}$/)
    expect(new Set(refs.map((r) => r.id)).size).toBe(2)
    // The phone sees the refs with the message, never the path.
    const msg = store.get("dev-1", c.id)!.messages[0]
    expect(msg.files).toEqual(refs)
    expect(JSON.stringify(msg)).not.toContain("charts/")
    expect(store.getFile("dev-1", refs[0].id)).toMatchObject({ path: "charts/a.png", node: "local", agent: "alpha", conversationId: c.id })
    expect(store.getFile("dev-2", refs[0].id)).toBeNull()
    expect(store.getFile("dev-1", "0".repeat(32))).toBeNull()
    expect(store.getFile("dev-1", "../../etc")).toBeNull()
    expect(store.appendWithFiles("dev-2", c.id, { role: "assistant", content: "x", at: 2 }, [])).toBeNull()
  })

  it("keeps at most 20 files per message, and forgets them with their message", () => {
    const c = store.create("dev-3", { node: "local", nodeName: "n", agent: "alpha" }, "hi")
    const many = [...Array(25)].map((_, i) => ({ type: "image" as const, filename: `f${i}.png`, mime: "image/png" }))
    const refs = store.appendWithFiles("dev-3", c.id, { role: "assistant", content: "ok", at: 1 }, many)!
    expect(refs).toHaveLength(20)
    for (let i = 0; i < 200; i++) store.append("dev-3", c.id, { role: "user", content: `m${i}`, at: 2 + i })
    expect(store.getFile("dev-3", refs[0].id)).toBeNull()
  })
})

describe("what is read out loud", () => {
  it("never reads pictures or file lines", () => {
    const said = speakableAnswer('Here is the chart. ![Sales by month](https://example.com/c.png)\n<agentx-artifact>{"filename":"c.png","mime":"image/png"}</agentx-artifact>')
    expect(said).toBe("Here is the chart.")
    expect(speakableAnswer("![only a picture](https://example.com/p.png)")).toBe("")
  })
})

describe("telling the agent how to attach files", () => {
  const base = { channel: "app", agentId: "alpha", agentName: "Alpha", sender: "owner", message: "hi" }
  it("adds the note when a session starts, and nothing without it", () => {
    const withHint = buildAgentContext({ ...base, attachHint: APP_ATTACH_HINT })
    expect(withHint).toContain("<agentx-artifact>")
    expect(buildAgentContext(base)).not.toContain("<agentx-artifact>")
  })
})
