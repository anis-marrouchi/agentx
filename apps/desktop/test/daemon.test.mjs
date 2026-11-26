// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import daemon from "../dist/daemon.js"

const { daemonTarget, cliArgs, shellQuote, readStatus, canStop, stopDaemon, isLoopbackUrl, DEFAULT_DAEMON_URL } = daemon

test("target: default, env URL, and the config's node.bind", () => {
  assert.deepEqual(daemonTarget({}), { url: DEFAULT_DAEMON_URL, config: undefined, cli: "agentx", cwd: homedir() })
  assert.equal(daemonTarget({ AGENTX_DAEMON_URL: "http://127.0.0.1:19999/" }).url, "http://127.0.0.1:19999")
  const dir = mkdtempSync(join(tmpdir(), "agentx-desktop-daemon-"))
  try {
    const cfg = join(dir, "agentx.json")
    writeFileSync(cfg, JSON.stringify({ node: { bind: "0.0.0.0:19123" } }))
    const t = daemonTarget({ AGENTX_CONFIG: cfg, AGENTX_CLI: "/opt/agentx/bin/agentx" })
    assert.deepEqual(t, { url: "http://127.0.0.1:19123", config: cfg, cli: "/opt/agentx/bin/agentx", cwd: dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("CLI arguments pin the config", () => {
  assert.deepEqual(cliArgs("start"), ["daemon", "start", "--detach"])
  assert.deepEqual(cliArgs("restart", "/x/agentx.json"), ["daemon", "restart", "-c", "/x/agentx.json"])
  assert.equal(shellQuote("/a/b-c.json"), "/a/b-c.json")
  assert.equal(shellQuote("/a b/it's"), `'/a b/it'\\''s'`)
})

const reply = (ok, body) => Promise.resolve({ ok, json: () => Promise.resolve(body) })
const T = { url: "http://127.0.0.1:1", cli: "agentx", cwd: "/" }

test("status: health decides running; pid and service when told", async () => {
  assert.deepEqual(await readStatus(T, () => Promise.reject(new Error("ECONNREFUSED"))), { running: false })
  assert.deepEqual(await readStatus(T, () => reply(false)), { running: false })
  const f = (url) => (url.endsWith("/health") ? reply(true, {}) : reply(true, { pid: 42, service: { kind: "launchd" } }))
  assert.deepEqual(await readStatus(T, f), { running: true, pid: 42, service: "launchd" })
  const old = (url) => (url.endsWith("/health") ? reply(true, {}) : reply(false))
  assert.deepEqual(await readStatus(T, old), { running: true })
})

test("Stop only signals a shell-started daemon's own pid", () => {
  assert.equal(canStop({ running: true, pid: 7, service: "none" }), true)
  assert.equal(canStop({ running: true, pid: 7, service: "launchd" }), false)
  assert.equal(canStop({ running: true, service: "none" }), false)
  assert.equal(canStop({ running: false }), false)
  const sent = []
  stopDaemon({ running: true, pid: 7, service: "none" }, (pid, sig) => sent.push([pid, sig]))
  assert.deepEqual(sent, [[7, "SIGTERM"]])
  assert.throws(() => stopDaemon({ running: true, pid: 7, service: "systemd" }, () => assert.fail("signalled")), /systemd/)
})

test("Stop is off for a daemon on another machine (its pid is not ours)", async () => {
  assert.ok(["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1"].every(isLoopbackUrl))
  assert.ok(!["http://10.0.0.5:18800", "http://box.example:18800", "not a url"].some(isLoopbackUrl))
  const shell = (url) => (url.endsWith("/health") ? reply(true, {}) : reply(true, { pid: 7, service: { kind: "none" } }))
  const far = await readStatus({ ...T, url: "http://10.0.0.5:18800" }, shell)
  assert.deepEqual(far, { running: true, pid: 7, service: "none", remote: true })
  assert.equal(canStop(far), false)
  assert.throws(() => stopDaemon(far, () => assert.fail("signalled")), /another machine/)
  assert.equal(canStop(await readStatus({ ...T, url: "http://localhost:18800" }, shell)), true)
})
