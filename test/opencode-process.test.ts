import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeProcessPool } from "../src/agents/opencode-process"
import { executeTask } from "../src/agents/runtime"
import { openCodeProcessPool } from "../src/agents/opencode-process"
import type { AgentDef } from "../src/daemon/config"

let dir: string
let pool: OpenCodeProcessPool
let oldPath: string | undefined
function binary(version = "2.0.12", fail = "") {
  writeFileSync(join(dir, "opencode"), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(dir, "calls"))}, JSON.stringify({args,pid:process.pid,chat:process.env.AGENTX_CHAT_ID})+'\\n');
if (args[0] === '--version') { console.log('opencode v${version}'); process.exit(0); }
if (args[0] === 'serve') {
 if (${JSON.stringify(fail)} === 'serve') process.exit(1);
 console.log(JSON.stringify({url:'http://127.0.0.1:12345'}));
 setInterval(()=>{},1000);
} else if (args[0] === 'run') {
 if (${JSON.stringify(fail)} === 'run') process.exit(1);
 console.log(JSON.stringify({type:'text',sessionID:'session-test',part:{text:'OK'}}));
}
`)
  chmodSync(join(dir, "opencode"), 0o755)
}
const calls = () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line))
const options = () => ({ key: "agent/chat", cwd: dir, env: { ...process.env, PATH: `${dir}:${oldPath}`, AGENTX_CHAT_ID: "chat" } })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agentx-open-pool-")); oldPath = process.env.PATH; pool = new OpenCodeProcessPool(2, 5000); binary() })
afterEach(() => { pool.stop(); openCodeProcessPool.stop(); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }) })

describe("OpenCode warm servers", () => {
  it("reuses servers and isolates conversations and effective configuration", async () => {
    const o = options()
    const first = await pool.acquire(o); first.release()
    const second = await pool.acquire(o)
    expect(second.reused).toBe(true)
    expect(second.env.OPENCODE_SERVER_PASSWORD).toBe(first.env.OPENCODE_SERVER_PASSWORD)
    second.release()
    for (const override of [{ key: "other" }, { model: "another" }, { permission: "bypassPermissions" }, { env: { ...o.env, AGENTX_CHAT_ID: "new" } }, { fresh: true }]) {
      const next = await pool.acquire({ ...o, ...override }); expect(next.reused).toBe(false); next.release()
    }
    expect(calls().filter(c => c.args[0] === "serve")).toHaveLength(6)
  })
  it("evicts idle servers and refuses to evict active ones", async () => {
    pool.stop(); pool = new OpenCodeProcessPool(2, 20)
    const o = options()
    const a = await pool.acquire(o)
    const b = await pool.acquire({ ...o, key: "two" })
    await expect(pool.acquire({ ...o, key: "three" })).rejects.toMatchObject({ standalone: true })
    a.release(); b.release()
    await new Promise(r => setTimeout(r, 35))
    const next = await pool.acquire(o); expect(next.reused).toBe(false); next.release()
  })
  it("does not launch an unsupported old server", async () => {
    binary("1.0.0")
    await expect(pool.acquire(options())).rejects.toThrow(/v2/)
    expect(calls().filter(c => c.args[0] === "serve")).toHaveLength(0)
  })
  it("rejects cancelled acquisition and replaces invalidated servers", async () => {
    const controller = new AbortController(); controller.abort()
    await expect(pool.acquire({ ...options(), signal: controller.signal })).rejects.toThrow(/cancelled/)
    const a = await pool.acquire(options()); a.invalidate(); a.release()
    const b = await pool.acquire(options()); expect(b.reused).toBe(false); b.release()
  })
  it("connects runtime turns to the warm server without changing model or resume ID", async () => {
    process.env.PATH = `${dir}:${oldPath}`
    const agent = { tier: "opencode", workspace: dir, model: "openai/configured-model", persistentProcess: true } as AgentDef
    for (let i = 0; i < 2; i++) {
      const r = await executeTask(agent, { agentId: "test", message: "hello" }, {}, undefined, undefined, "existing-session")
      expect(r.content).toBe("OK")
    }
    const log = calls()
    expect(log.filter(c => c.args[0] === "serve")).toHaveLength(1)
    for (const c of log.filter(c => c.args[0] === "run")) {
      expect(c.args).toContain("--server")
      expect(c.args).toContain("openai/configured-model")
      expect(c.args).toContain("existing-session")
    }
  })
  it("falls back before dispatch when the server cannot start", async () => {
    binary("2.0.12", "serve"); process.env.PATH = `${dir}:${oldPath}`
    const r = await executeTask({ tier: "opencode", workspace: dir, persistentProcess: true } as AgentDef, { agentId: "test", message: "hi" }, {})
    expect(r.content).toBe("OK")
    expect(calls().filter(c => c.args[0] === "run")[0].args).toContain("--standalone")
  })
  it("never replays a failed dispatched turn", async () => {
    binary("2.0.12", "run"); process.env.PATH = `${dir}:${oldPath}`
    const r = await executeTask({ tier: "opencode", workspace: dir, persistentProcess: true } as AgentDef, { agentId: "test", message: "hi" }, {})
    expect(r.error).toBeTruthy()
    expect(calls().filter(c => c.args[0] === "run")).toHaveLength(1)
  })
})
