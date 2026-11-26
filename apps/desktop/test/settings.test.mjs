// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import settings from "../dist/settings.js"

const { DEFAULT_SETTINGS, parseSettings, loadSettings, saveSettings, settingsPath } = settings

test("defaults: no login item, window at launch, close hides", () => {
  assert.deepEqual(DEFAULT_SETTINGS, { openAtLogin: false, showOnLaunch: true, closeAction: "hide" })
})

test("bad or unknown values fall back to the default", () => {
  assert.deepEqual(parseSettings(null), DEFAULT_SETTINGS)
  assert.deepEqual(parseSettings({ openAtLogin: "yes", showOnLaunch: 0, closeAction: "explode", extra: 1 }), DEFAULT_SETTINGS)
  assert.deepEqual(parseSettings({ openAtLogin: true, showOnLaunch: false, closeAction: "quit" }), { openAtLogin: true, showOnLaunch: false, closeAction: "quit" })
})

test("saved settings survive a restart; a broken file gives the defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentx-desktop-settings-"))
  try {
    assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS)
    const mine = { openAtLogin: true, showOnLaunch: false, closeAction: "quit" }
    saveSettings(dir, mine)
    assert.deepEqual(JSON.parse(readFileSync(settingsPath(dir), "utf8")), mine)
    assert.deepEqual(loadSettings(dir), mine)
    writeFileSync(settingsPath(dir), "{not json")
    let seen = null
    assert.deepEqual(loadSettings(dir, (e) => (seen = e)), DEFAULT_SETTINGS)
    assert.ok(seen)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
