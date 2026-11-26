// Run with `npm test` (compiles src/ to dist/ first).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import daemon from "../dist/daemon.js"

const { daemonTarget, cliArgs, shellQuote, readStatus, canStop, stopDaemon, isLoopbackUrl, isAgentxProcess, managedService, startRefusal, DEFAULT_DAEMON_URL } = daemon

test("target: default, env URL, and the config's node.bind", () => {
  // No config: no folder to start in (never the home folder).
  assert.deepEqual(daemonTarget({}), { url: DEFAULT_DAEMON_URL, config: undefined, cli: "agentx", cwd: undefined })
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

test("CLI arguments pin the config; Restart waits for running tasks", () => {
  assert.deepEqual(cliArgs("start"), ["daemon", "start", "--detach"])
  assert.deepEqual(cliArgs("restart"), ["daemon", "restart", "--when-idle", "--abort-on-timeout"])
  assert.deepEqual(cliArgs("restart", "/x/agentx.json"), ["daemon", "restart", "--when-idle", "--abort-on-timeout", "-c", "/x/agentx.json"])
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
  stopDaemon({ running: true, pid: 7, service: "none" }, (pid, sig) => sent.push([pid, sig]), () => true)
  assert.deepEqual(sent, [[7, "SIGTERM"]])
  assert.throws(() => stopDaemon({ running: true, pid: 7, service: "systemd" }, () => assert.fail("signalled")), /systemd/)
})

test("Stop is off for a daemon on another machine (its pid is not ours)", async () => {
  assert.ok(["http://127.0.0.1:1", "http://127.0.1.1:1", "http://127.255.255.254:1", "http://localhost:1", "http://[::1]:1"].every(isLoopbackUrl))
  assert.ok(!["http://10.0.0.5:18800", "http://box.example:18800", "not a url", "::1", "http://0.0.0.0:18800", "http://128.0.0.1:1", "http://127.0.0.1.example:1"].some(isLoopbackUrl))
  const shell = (url) => (url.endsWith("/health") ? reply(true, {}) : reply(true, { pid: 7, service: { kind: "none" } }))
  const far = await readStatus({ ...T, url: "http://10.0.0.5:18800" }, shell)
  assert.deepEqual(far, { running: true, pid: 7, service: "none", remote: true })
  assert.equal(canStop(far), false)
  assert.throws(() => stopDaemon(far, () => assert.fail("signalled"), () => true), /another machine/)
  assert.equal(canStop(await readStatus({ ...T, url: "http://localhost:18800" }, shell)), true)
})

test("Stop checks the pid is agentx here (a forwarded port reports another machine's pid)", () => {
  const ps = (out) => (cmd, args) => (cmd === "ps" && args.join(" ") === "-p 7 -o command=" ? out : null)
  assert.equal(isAgentxProcess(7, "darwin", ps("node /opt/agentx/dist/cli.js daemon start\n")), true)
  assert.equal(isAgentxProcess(7, "linux", ps("/usr/sbin/sshd -D\n")), false)
  assert.equal(isAgentxProcess(7, "linux", ps(null)), false) // no such process
  assert.equal(isAgentxProcess(7, "win32", () => '"node.exe","7","Console","1","90,000 K"\r\n'), true)
  assert.throws(() => stopDaemon({ running: true, pid: 7, service: "none" }, () => assert.fail("signalled"), () => false), /not agentx/)
})

test("managed daemon: a loaded launchd job or systemd unit is found", () => {
  const list = "PID\tStatus\tLabel\n67773\t0\ttn.noqta.agentx.voice\n-\t0\tapplication.dev.agentx.desktop.1.2\n-\t78\ttn.noqta.agentx\n"
  assert.equal(managedService("darwin", () => list, {}), "launchd tn.noqta.agentx")
  assert.equal(managedService("darwin", () => list.replace("tn.noqta.agentx\n", "other\n"), {}), null)
  assert.equal(managedService("darwin", () => "-\t0\tcom.me.daemon\n", { AGENTX_SERVICE: "com.me.daemon" }), "launchd com.me.daemon")
  assert.equal(managedService("darwin", () => null, {}), null) // launchctl failed
  const sd = (loaded) => (cmd, args) => (cmd === "systemctl" && args.includes(loaded.scope) === loaded.user && args.at(-1) === "agentx.service" ? "loaded\n" : "not-found\n")
  assert.equal(managedService("linux", sd({ scope: "--user", user: true }), {}), "systemd user agentx.service")
  assert.equal(managedService("linux", sd({ scope: "--user", user: false }), {}), "systemd agentx.service")
  assert.equal(managedService("linux", () => "not-found\n", {}), null)
  assert.equal(managedService("win32", () => assert.fail("ran"), {}), null)
})

test("Start: never next to a managed daemon, never without AGENTX_CONFIG", () => {
  const withCfg = { ...T, config: "/x/agentx.json", cwd: "/x" }
  const down = { running: false }
  assert.equal(startRefusal(down, withCfg, null), null)
  assert.equal(startRefusal(down, withCfg, "launchd tn.noqta.agentx"), "kept by launchd tn.noqta.agentx")
  assert.equal(startRefusal(down, { ...T, cwd: undefined }, null), "set AGENTX_CONFIG")
  assert.equal(startRefusal({ running: true }, withCfg, null), "already running")
  assert.equal(startRefusal(null, withCfg, null), "checking")
})

test("Restart runs in the daemon's own folder, never a guessed one", async () => {
  const { restartTarget, runCli } = daemon
  const T0 = { url: "http://127.0.0.1:1", cli: "agentx" }
  assert.equal(restartTarget(T0, { running: true }), null)
  assert.deepEqual(restartTarget(T0, { running: true, cwd: "/srv/ax" }), { ...T0, cwd: "/srv/ax" })
  // The daemon's own folder wins over its config's folder.
  assert.deepEqual(restartTarget(T0, { running: true, cwd: "/srv/ax", configPath: "/etc/ax/agentx.json" }), { ...T0, config: "/etc/ax/agentx.json", cwd: "/srv/ax" })
  assert.deepEqual(restartTarget(T0, { running: true, configPath: "/etc/ax/agentx.json" }), { ...T0, config: "/etc/ax/agentx.json", cwd: "/etc/ax" })
  // `daemon start -c agentx.json`: a relative config is read from the daemon's folder, not the app's ".".
  // resolve() gives the platform's own form (a drive letter on Windows).
  assert.deepEqual(restartTarget(T0, { running: true, cwd: "/srv/ax", configPath: "agentx.json" }), { ...T0, config: resolve("/srv/ax", "agentx.json"), cwd: "/srv/ax" })
  assert.deepEqual(restartTarget(T0, { running: true, cwd: "/srv/ax", configPath: "conf/agentx.json" }), { ...T0, config: resolve("/srv/ax", "conf/agentx.json"), cwd: "/srv/ax" })
  assert.equal(restartTarget(T0, { running: true, configPath: "agentx.json" }), null)
  const pinned = { ...T0, config: "/a/agentx.json", cwd: "/a" }
  assert.equal(restartTarget(pinned, { running: true, cwd: "/b" }), pinned)
  await assert.rejects(runCli(T0, ["daemon", "restart"]), /AGENTX_CONFIG/)
  const full = (url) => (url.endsWith("/health") ? reply(true, {}) : reply(true, { pid: 4, service: { kind: "launchd" }, cwd: "/srv/ax", configPath: "/srv/ax/agentx.json" }))
  assert.deepEqual(await readStatus(T0, full), { running: true, pid: 4, service: "launchd", cwd: "/srv/ax", configPath: "/srv/ax/agentx.json" })
})
