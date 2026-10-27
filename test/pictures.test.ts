import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createServer, type Server } from "http"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { AddressInfo } from "net"
import sharp from "sharp"
import { handleBoardRequest, type Ctx } from "../src/daemon/board-dashboard"
import { daemonConfigSchema } from "../src/daemon/config"
import { handleAgentPicture } from "../src/daemon/pictures-panel"
import { isMeshGatedPath } from "../src/daemon/mesh-auth"
import {
  AGENT_PICTURE_PATH, PICTURE_MAX_BYTES, PICTURE_SIDE, PictureError, listPictures, preparePicture, removePicture, setPicture,
} from "../src/pictures/pictures"
import { setOwnPicture } from "../src/pictures/self"
import { renderPeoplePage } from "../src/daemon/ui/pages/people"
import { renderOrgPage } from "../src/daemon/ui/pages/org"
import { WALL_PAGE_SCRIPT } from "../src/daemon/ui/pages/wall.client"
import type { Person } from "../src/people/people"

// Profile pictures for agents and people (#1425): the checks every path
// shares, the owner's upload through the dashboard's own request handler
// (so the token gate is the real one), an agent setting its own picture
// through the daemon route, and the initials when there is no picture.

const png = (w = 40, h = 20, background = "#3366cc") => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer()
const jpegWithExif = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "#cc6633" } })
  .jpeg().withMetadata({ exif: { IFD0: { Copyright: "secret-owner-name", Artist: "secret-owner-name" } } }).toBuffer()
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')

describe("preparePicture: the checks every way in goes through", () => {
  it("re-encodes to a square WebP of the fixed side", async () => {
    const out = await preparePicture(await png(40, 20))
    const meta = await sharp(out).metadata()
    expect(meta.format).toBe("webp")
    expect([meta.width, meta.height]).toEqual([PICTURE_SIDE, PICTURE_SIDE])
  })

  it("keeps no EXIF", async () => {
    const src = await jpegWithExif()
    expect((await sharp(src).metadata()).exif).toBeDefined()
    expect(src.includes("secret-owner-name")).toBe(true)
    const out = await preparePicture(src)
    expect((await sharp(out).metadata()).exif).toBeUndefined()
    expect(out.includes("secret-owner-name")).toBe(false)
  })

  it("accepts PNG, JPEG and WebP", async () => {
    const webp = await sharp(await png()).webp().toBuffer()
    for (const b of [await png(), await jpegWithExif(), webp]) await expect(preparePicture(b)).resolves.toBeInstanceOf(Buffer)
  })

  it("refuses a file over 1 MB, a non-image, an SVG and an empty file, with words", async () => {
    const big = Buffer.concat([await png(), Buffer.alloc(PICTURE_MAX_BYTES)])
    await expect(preparePicture(big)).rejects.toThrow(/limit is 1 MB/)
    await expect(preparePicture(Buffer.from("just some text, not a picture"))).rejects.toThrow(/not a picture.*PNG, JPEG or WebP/)
    await expect(preparePicture(SVG)).rejects.toThrow(/SVG pictures are not accepted/)
    await expect(preparePicture(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).rejects.toThrow(/SVG/)
    await expect(preparePicture(Buffer.alloc(0))).rejects.toThrow(/empty/)
  })

  it("refuses a file that says PNG but is not one", async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("garbage")])
    await expect(preparePicture(fake)).rejects.toBeInstanceOf(PictureError)
  })
})

describe("the store", () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agentx-pictures-")) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it("keeps one picture per member, under .agentx/pictures, and a new one is a new address", async () => {
    const a = await setPicture(root, "agent", "coder", await png(10, 10))
    const b = await setPicture(root, "agent", "coder", await png(30, 10, "#22aa44"))
    expect(a.version).not.toBe(b.version)
    expect(readdirSync(join(root, ".agentx", "pictures", "agent"))).toEqual([`coder.${b.version}.webp`])
    expect(listPictures(root, "agent")).toEqual({ coder: b.version })
    expect(removePicture(root, "agent", "coder")).toBe(true)
    expect(listPictures(root, "agent")).toEqual({})
    expect(removePicture(root, "agent", "coder")).toBe(false)
  })

  it("refuses an id that could leave the folder", async () => {
    await expect(setPicture(root, "person", "../x", await png())).rejects.toThrow(/not a valid person id/)
  })
})

// --- The dashboard: owner upload, serve, remove ---

const PEOPLE: Person[] = [{ id: "sara", name: "Sara B", role: "member", identities: [] }]
const home = process.cwd()
let dir: string
let server: Server
let base: string
let token: string | undefined

describe("the dashboard (owner)", () => {
  beforeAll(async () => {
    process.chdir(mkdtempSync(join(tmpdir(), "agentx-pictures-dash-")))
    dir = process.cwd()
    server = createServer((req, res) => {
      const config = daemonConfigSchema.parse({
        node: { id: "node-a", name: "node-a" }, people: PEOPLE,
        agents: { coder: { name: "Coder", workspace: dir, tier: "claude-code" } },
      })
      void handleBoardRequest(req, res, { boards: [], sources: new Map(), token, config } as unknown as Ctx)
    })
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    process.chdir(home)
    rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => { token = undefined })
  afterEach(() => rmSync(join(dir, ".agentx"), { recursive: true, force: true }))

  const WRITE = { "X-Requested-With": "agentx-board" }
  const put = (kind: string, id: string, body: Buffer, headers: Record<string, string> = WRITE) =>
    fetch(`${base}/api/admin/pictures/${kind}/${id}`, { method: "PUT", headers: { "Content-Type": "image/png", ...headers }, body })
  const list = async (headers: Record<string, string> = {}) => (await fetch(`${base}/api/admin/pictures`, { headers })).json() as Promise<any>

  it("with no picture, lists none: every page keeps the initials", async () => {
    expect(await list()).toEqual({ agent: {}, person: {} })
  })

  it("the owner uploads for an agent and a person; the list names them at once and the picture is served", async () => {
    expect((await put("agent", "coder", await png())).status).toBe(200)
    expect((await put("person", "sara", await jpegWithExif())).status).toBe(200)
    expect((await put("person", "owner", await png())).status).toBe(200)
    const l = await list()
    expect(Object.keys(l.agent)).toEqual(["coder"])
    expect(Object.keys(l.person).sort()).toEqual(["owner", "sara"])
    const r = await fetch(`${base}${l.agent.coder}`)
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("image/webp")
    expect(r.headers.get("cache-control")).toMatch(/immutable/)
    expect(r.headers.get("x-content-type-options")).toBe("nosniff")
    expect((await sharp(Buffer.from(await r.arrayBuffer())).metadata()).width).toBe(PICTURE_SIDE)
  })

  it("serves a picture only at the version the list names", async () => {
    await put("agent", "coder", await png())
    expect((await fetch(`${base}/api/pictures/agent/coder`)).status).toBe(404)
    expect((await fetch(`${base}/api/pictures/agent/coder?v=0000000000000000`)).status).toBe(404)
    expect((await fetch(`${base}/api/pictures/agent/../../agentx.json?v=0000000000000000`)).status).toBe(404)
  })

  it("remove brings the initials back", async () => {
    await put("agent", "coder", await png())
    const old = (await list()).agent.coder
    const r = await fetch(`${base}/api/admin/pictures/agent/coder`, { method: "DELETE", headers: WRITE })
    expect(await r.json()).toEqual({ ok: true, removed: true })
    expect(await list()).toEqual({ agent: {}, person: {} })
    expect((await fetch(`${base}${old}`)).status).toBe(404)
  })

  it("refuses bad files with a clear message", async () => {
    let r = await put("agent", "coder", SVG)
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/SVG pictures are not accepted/)
    r = await put("agent", "coder", Buffer.from("hello"))
    expect((await r.json()).error).toMatch(/not a picture/)
    r = await put("agent", "coder", Buffer.alloc(PICTURE_MAX_BYTES + 10, 1))
    expect(r.status).toBe(413)
    expect((await r.json()).error).toMatch(/limit is 1 MB/)
    expect(await list()).toEqual({ agent: {}, person: {} })
  })

  it("only for members agentx.json lists, and only from a same-origin page", async () => {
    expect((await put("agent", "ghost", await png())).status).toBe(404)
    expect((await put("person", "nobody", await png())).status).toBe(404)
    expect((await put("agent", "coder", await png(), {})).status).toBe(400)
  })

  it("is the owner's: behind the dashboard token", async () => {
    token = "owner-secret"
    expect((await fetch(`${base}/api/admin/pictures`)).status).toBe(401)
    expect((await put("agent", "coder", await png())).status).toBe(401)
    const auth = { Authorization: "Bearer owner-secret" }
    expect((await put("agent", "coder", await png(), { ...WRITE, ...auth })).status).toBe(200)
    // The <img> carries no token: the versioned address alone is enough.
    const url = (await list(auth)).agent.coder
    expect((await fetch(`${base}${url}`)).status).toBe(200)
  })
})

// --- An agent sets its own picture (daemon route) ---

describe("an agent sets its own picture", () => {
  let root: string
  let srv: Server
  let url: string
  /** The running turns: task id -> agent. */
  const running: Record<string, string> = { "task-coder": "coder", "task-writer": "writer" }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "agentx-pictures-self-"))
    srv = createServer((req, res) => {
      const u = new URL(req.url || "/", "http://localhost")
      const task = String(req.headers["x-agentx-task"] || "")
      void handleAgentPicture(req, res, u, { root, provenAgent: () => running[task] ?? null })
    })
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
    url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()))
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => rmSync(join(root, ".agentx"), { recursive: true, force: true }))

  const env = (agent: string, task?: string) => ({ AGENTX_AGENT_ID: agent, ...(task ? { AGENTX_TASK_ID: task } : {}) }) as NodeJS.ProcessEnv
  const fileOf = async (b: Promise<Buffer> | Buffer) => {
    const f = join(root, `in-${Math.random().toString(36).slice(2)}.bin`)
    writeFileSync(f, await b)
    return f
  }

  it("the route is gated off this machine like agent memory", () => {
    expect(isMeshGatedPath(AGENT_PICTURE_PATH)).toBe(true)
  })

  it("sets its own picture with a valid image", async () => {
    const r = await setOwnPicture(await fileOf(png()), undefined, { daemonUrl: url, env: env("coder", "task-coder") })
    expect(r).toMatchObject({ ok: true })
    expect(Object.keys(listPictures(root, "agent"))).toEqual(["coder"])
  })

  it("the same command for another agent is refused, before and at the daemon", async () => {
    const f = await fileOf(png())
    const r = await setOwnPicture(f, "writer", { daemonUrl: url, env: env("coder", "task-coder") })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/only change its own picture/)
    // Lying about who it is: the run it names belongs to coder.
    const forged = await fetch(`${url}${AGENT_PICTURE_PATH}?agent=writer`, { method: "PUT", headers: { "X-AgentX-Task": "task-coder" }, body: await png() })
    expect(forged.status).toBe(403)
    expect((await forged.json()).error).toMatch(/only change its own picture/)
    // No running turn named at all.
    const none = await fetch(`${url}${AGENT_PICTURE_PATH}?agent=writer`, { method: "PUT", body: await png() })
    expect(none.status).toBe(403)
    expect(listPictures(root, "agent")).toEqual({})
  })

  it("needs the run's proof", async () => {
    const r = await setOwnPicture(await fileOf(png()), undefined, { daemonUrl: url, env: env("coder") })
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/no proof/) })
  })

  it("bad files are refused with the same words as an upload", async () => {
    for (const [b, why] of [[SVG, /SVG/], [Buffer.from("text"), /not a picture/], [Buffer.alloc(PICTURE_MAX_BYTES + 1, 1), /limit is 1 MB/]] as const) {
      const r = await setOwnPicture(await fileOf(b), undefined, { daemonUrl: url, env: env("coder", "task-coder") })
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(why)
    }
    // Straight to the daemon, past the CLI's own checks.
    const r = await fetch(`${url}${AGENT_PICTURE_PATH}`, { method: "PUT", headers: { "X-AgentX-Task": "task-coder" }, body: SVG })
    expect(r.status).toBe(400)
  })

  it("removes its own picture", async () => {
    await setOwnPicture(await fileOf(png()), undefined, { daemonUrl: url, env: env("coder", "task-coder") })
    const r = await setOwnPicture(null, undefined, { daemonUrl: url, env: env("coder", "task-coder") })
    expect(r).toMatchObject({ ok: true, message: expect.stringMatching(/initials show again/) })
    expect(listPictures(root, "agent")).toEqual({})
  })
})

// --- The pages: the initials stay when there is no picture ---

describe("the pages", () => {
  /** The Wall's avatar(), run on its own with a given picture list. */
  function wallAvatar(pics: unknown) {
    const src = WALL_PAGE_SCRIPT
    const pick = (name: string) => {
      const start = src.indexOf(`function ${name}(`)
      let depth = 0, i = src.indexOf("{", start)
      for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break }
      return src.slice(start, i + 1)
    }
    const body = ["esc", "hue", "initials", "pictureOf", "avatar"].map(pick).join("\n")
    // eslint-disable-next-line no-new-func
    return new Function("S", "agentInfo", "nameOf", `${body}; return avatar`)(
      { pics }, () => ({ coder: { name: "Code Bot", live: false } }), () => "Code Bot",
    ) as (id: string, size?: string, person?: boolean) => string
  }

  it("the Wall shows the initials exactly as before when no picture is set", () => {
    const before = wallAvatar(null)("coder")
    expect(before).toContain(">CB</button>")
    expect(before).not.toContain("<img")
    expect(wallAvatar({ agent: {}, person: {} })("coder")).toBe(before)
    expect(wallAvatar({ agent: {}, person: {} })("sara", "sm", true)).toBe(wallAvatar(null)("sara", "sm", true))
  })

  it("the Wall uses the picture when one is set, for agents and people", () => {
    const av = wallAvatar({ agent: { coder: "/api/pictures/agent/coder?v=abc" }, person: { sara: "/api/pictures/person/sara?v=def" } })
    expect(av("coder")).toContain('<img src="/api/pictures/agent/coder?v=abc"')
    expect(av("coder")).toContain("av--pic")
    expect(av("sara", "sm", true)).toContain('<img src="/api/pictures/person/sara?v=def"')
    expect(av("writer")).not.toContain("<img")
  })

  it("People and Org read the picture list", () => {
    expect(renderPeoplePage()).toContain("/api/admin/pictures")
    expect(renderOrgPage()).toContain("/api/admin/pictures")
  })
})
