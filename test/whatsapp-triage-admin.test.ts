import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { addWatchRule, deleteWatchRule, editWatchRule, updateWhatsappTriage, whatsappTriageSettings } from "../src/daemon/whatsapp-triage-admin"
import { renderAdminPage } from "../src/daemon/ui/pages/admin"

// WhatsApp triage in the dashboard (#328): the admin API and the page script.

let dir: string
let cwd: string

const read = () => JSON.parse(readFileSync(join(dir, "agentx.json"), "utf-8"))

beforeEach(() => {
  cwd = process.cwd()
  dir = mkdtempSync(join(tmpdir(), "wa-admin-"))
  writeFileSync(join(dir, "agentx.json"), JSON.stringify({
    node: { id: "t", name: "t" },
    agents: { helper: { name: "Helper", workspace: dir } },
    // An unreachable daemon, so the post-write reload goes nowhere.
    dashboard: { daemonUrl: "http://127.0.0.1:9" },
  }))
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(cwd)
  rmSync(dir, { recursive: true, force: true })
})

describe("admin API", () => {
  it("adds, toggles and removes a watch rule", () => {
    addWatchRule({ id: "test", agent: "helper", chats: "+1 555 000 1111, 120363000000000000@g.us", quietStart: "22:00", quietEnd: "07:00" })
    updateWhatsappTriage({ enabled: true })
    expect(read().whatsappTriage).toMatchObject({
      enabled: true,
      rules: [{ id: "test", agent: "helper", chats: ["+1 555 000 1111", "120363000000000000@g.us"], quietHours: { start: "22:00", end: "07:00" } }],
    })
    editWatchRule({ id: "test", patch: { enabled: false } })
    expect(read().whatsappTriage.rules[0].enabled).toBe(false)
    deleteWatchRule({ id: "test" })
    expect(read().whatsappTriage.rules).toEqual([])
  })

  it("refuses an invalid rule without writing", () => {
    expect(() => addWatchRule({ id: "all", agent: "helper" })).toThrow(/at least one chat or sender/)
    expect(() => addWatchRule({ id: "x", agent: "nobody", chats: "1" })).toThrow(/Unknown agent/)
    expect(() => addWatchRule({ id: "x", agent: "helper", chats: "1", quietStart: "9pm", quietEnd: "07:00" })).toThrow(/HH:MM/)
    expect(read().whatsappTriage).toBeUndefined()
  })

  it("reports whether the secret is set, never its value", () => {
    process.env.WA_ADMIN_TEST_SECRET = "hush"
    const s = whatsappTriageSettings({ whatsappTriage: { secretEnv: "WA_ADMIN_TEST_SECRET" } }) as any
    delete process.env.WA_ADMIN_TEST_SECRET
    expect(s.secretSet).toBe(true)
    expect(JSON.stringify(s)).not.toContain("hush")
  })
})

describe("admin page", () => {
  it("ships a script that parses", () => {
    const html = renderAdminPage({})
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(html).toContain("function renderWaTriage")
    for (const s of scripts) expect(() => new Function(s)).not.toThrow()
  })
})
