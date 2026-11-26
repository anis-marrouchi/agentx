// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import menu from "../dist/menu.js"

const settings = { openAtLogin: false, showOnLaunch: true, closeAction: "hide" }
const calls = []
const actions = {
  onToggleWindow: () => calls.push("toggle"),
  onQuit: () => calls.push("quit"),
  onDaemon: (a) => calls.push(a),
  onSetting: (c) => calls.push(c),
}
const state = (over) => ({ windowVisible: true, daemon: { running: true, pid: 9, service: "none" }, busy: null, settings, loginItemSupported: true, startRefusal: null, remote: false, ...over })
const items = (s) => menu.menuTemplate(s, actions).filter((i) => i.type !== "separator")
const byLabel = (s, prefix) => items(s).find((i) => i.label.startsWith(prefix))

test("all six controls are in the menu", () => {
  const labels = items(state()).map((i) => i.label)
  assert.deepEqual(labels, ["Hide AgentX", "Daemon: running", "Start", "Stop", "Restart…", "Open at login", "Show the window at launch", "Closing the window", "Quit AgentX"])
  assert.equal(byLabel(state({ windowVisible: false }), "Show").label, "Show AgentX")
})

test("daemon buttons follow its status", () => {
  const on = state()
  assert.deepEqual([byLabel(on, "Start").enabled, byLabel(on, "Stop").enabled, byLabel(on, "Restart").enabled], [false, true, true])
  const off = state({ daemon: { running: false } })
  assert.equal(byLabel(off, "Daemon").label, "Daemon: stopped")
  assert.deepEqual([byLabel(off, "Start").enabled, byLabel(off, "Stop").enabled, byLabel(off, "Restart").enabled], [true, false, false])
  const kept = state({ daemon: { running: true, pid: 9, service: "launchd" } })
  assert.equal(byLabel(kept, "Daemon").label, "Daemon: running (kept by launchd)")
  assert.equal(byLabel(kept, "Stop").enabled, false)
  assert.equal(byLabel(kept, "Restart").enabled, true)
  const managed = state({ daemon: { running: false }, startRefusal: "kept by launchd tn.noqta.agentx" })
  assert.equal(byLabel(managed, "Start").label, "Start (kept by launchd tn.noqta.agentx)")
  assert.deepEqual([byLabel(managed, "Start").enabled, byLabel(managed, "Restart").enabled], [false, false])
  const noCfg = state({ daemon: { running: false }, startRefusal: "set AGENTX_CONFIG" })
  assert.equal(byLabel(noCfg, "Start").enabled, false)
  // Running: the plain label, whatever startRefusal says.
  assert.equal(byLabel(state({ startRefusal: "already running" }), "Start").label, "Start")
  const far = state({ remote: true, daemon: { running: true, pid: 9, service: "none", remote: true } })
  assert.deepEqual([byLabel(far, "Start").label, byLabel(far, "Stop").label, byLabel(far, "Restart").label], ["Start (on another machine)", "Stop (on another machine)", "Restart (on another machine)"])
  assert.deepEqual([byLabel(far, "Start").enabled, byLabel(far, "Stop").enabled, byLabel(far, "Restart").enabled], [false, false, false])
  const farDown = state({ remote: true, daemon: { running: false } })
  assert.equal(byLabel(farDown, "Daemon").label, "Daemon: stopped")
  assert.deepEqual([byLabel(farDown, "Start").enabled, byLabel(farDown, "Stop").enabled, byLabel(farDown, "Restart").enabled], [false, false, false])
  const busy = state({ busy: "restarting" })
  assert.equal(byLabel(busy, "Daemon").label, "Daemon: restarting…")
  assert.ok(["Start", "Stop", "Restart"].every((l) => byLabel(busy, l).enabled === false))
})

test("settings items show and change the saved values", () => {
  const s = state({ settings: { openAtLogin: true, showOnLaunch: false, closeAction: "quit" } })
  assert.equal(byLabel(s, "Open at login").checked, true)
  assert.equal(byLabel(s, "Show the window").checked, false)
  const radios = byLabel(s, "Closing").submenu
  assert.deepEqual(radios.map((r) => [r.label, r.checked]), [["Hide to the tray", false], ["Quit the app", true]])
  calls.length = 0
  radios[0].click()
  byLabel(s, "Open at login").click({ checked: false })
  byLabel(s, "Quit").click()
  assert.deepEqual(calls, [{ closeAction: "hide" }, { openAtLogin: false }, "quit"])
  assert.equal(byLabel(state({ loginItemSupported: false }), "Open at login").enabled, false)
})
