// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import menu from "../dist/menu.js"

const settings = { openAtLogin: false, showOnLaunch: true, closeAction: "hide", orbVisible: true, globalKey: false, orbAgent: "" }
const calls = []
const actions = {
  onToggleWindow: () => calls.push("toggle"),
  onToggleOrb: () => calls.push("orb"),
  onQuit: () => calls.push("quit"),
  onDaemon: (a) => calls.push(a),
  onSetting: (c) => calls.push(c),
}
const state = (over) => ({ windowVisible: true, daemon: { running: true, pid: 9, service: "none" }, busy: null, settings, loginItemSupported: true, startRefusal: null, remote: false, orbVisible: true, talkLine: "Talk: hold the orb (global key off)", orbAgents: [], ...over })
const items = (s) => menu.menuTemplate(s, actions).filter((i) => i.type !== "separator")
const byLabel = (s, prefix) => items(s).find((i) => i.label.startsWith(prefix))

test("all the controls are in the menu", () => {
  const labels = items(state()).map((i) => i.label)
  assert.deepEqual(labels, ["Hide AgentX", "Hide orb", "Talk: hold the orb (global key off)", "Orb talks to: no agent yet", "Global talk key", "Daemon: running", "Start", "Stop", "Restart…", "Open at login", "Show the window at launch", "Closing the window", "Quit AgentX"])
  assert.equal(byLabel(state({ windowVisible: false }), "Show").label, "Show AgentX")
})

test("orb toggle, talk line and global key follow the state (#2265)", () => {
  assert.equal(byLabel(state({ orbVisible: false }), "Show orb").label, "Show orb")
  const line = "Talk: press ⌥Space, press again to send (Wayland does not let apps see a key held down)"
  const talk = byLabel(state({ talkLine: line }), "Talk:")
  assert.deepEqual([talk.label, talk.enabled], [line, false])
  calls.length = 0
  byLabel(state(), "Hide orb").click()
  byLabel(state(), "Global talk key").click({ checked: true })
  assert.deepEqual(calls, ["orb", { globalKey: true }])
  assert.equal(byLabel(state({ settings: { ...settings, globalKey: true } }), "Global talk key").checked, true)
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
  const s = state({ settings: { ...settings, openAtLogin: true, showOnLaunch: false, closeAction: "quit" } })
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

test("Orb talks to: the chosen agent, picked from the node's agents", () => {
  const agents = [{ id: "secretary", name: "Secretary" }, { id: "coder", name: "Coder" }]
  assert.equal(byLabel(state(), "Orb talks to: no agent yet").enabled, false)
  const item = byLabel(state({ orbAgents: agents, settings: { ...settings, orbAgent: "coder" } }), "Orb talks to: Coder")
  assert.deepEqual(item.submenu.map((x) => x.checked), [false, true])
  // A chosen agent that is gone: the node's first is used and shown.
  assert.ok(byLabel(state({ orbAgents: agents, settings: { ...settings, orbAgent: "gone" } }), "Orb talks to: Secretary"))
  assert.ok(byLabel(state({ orbAgents: agents, orbDefault: "coder" }), "Orb talks to: Coder"), "none chosen: the node's default")
  calls.length = 0
  byLabel(state({ orbAgents: agents }), "Orb talks to: Secretary").submenu[1].click()
  assert.deepEqual(calls, [{ orbAgent: "coder" }])
})
