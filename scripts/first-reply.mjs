// Times a clean folder from `npx agentix-cli start` to the first agent reply in the browser chat (#1286).
//
//   node scripts/first-reply.mjs                       # packs this checkout (run `pnpm build` first)
//   node scripts/first-reply.mjs agentix-cli@latest    # a published version
//
// A stub model stands in for the Anthropic API (ANTHROPIC_BASE_URL), so no
// real key is needed. No key is in the environment either: like a person on
// the chat page, the script reads the "no model yet" box, pastes a key into
// it, then sends the first message. Every call goes to the dashboard routes
// the agent page itself uses. It fails when the reply takes longer than
// FIRST_REPLY_BUDGET_S (default 300), and prints the time either way.
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const STUB_REPLY = 'Hello from the stub model.'
const budgetS = Number(process.env.FIRST_REPLY_BUDGET_S) || 300
const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), 'agentx-first-reply-'))
const dir = join(temp, 'team')
mkdirSync(dir)

// --- A stub of POST /v1/messages: plain JSON, or SSE when stream is set ---
function stubModel() {
  let requests = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url.endsWith('/v1/messages')) { res.writeHead(404).end(); return }
      requests++
      const body = JSON.parse(raw || '{}')
      const usage = { input_tokens: 10, output_tokens: 6 }
      const message = { id: 'msg_stub', type: 'message', role: 'assistant', model: body.model || 'stub', stop_reason: 'end_turn', stop_sequence: null }
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: STUB_REPLY }], usage }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } })
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: STUB_REPLY } })
      send('content_block_stop', { index: 0 })
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } })
      send('message_stop', {})
      res.end()
    })
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${server.address().port}`, requests: () => requests })))
}

// A PATH with node, npm and npx only. A `claude` next to them would make
// `start` pick the Claude Code engine, which needs a real login.
function cleanPath() {
  const bin = join(temp, 'bin')
  mkdirSync(bin)
  const nodeDir = dirname(process.execPath)
  for (const name of ['node', 'npm', 'npx']) {
    const target = join(nodeDir, name)
    if (existsSync(target)) symlinkSync(realpathSync(target), join(bin, name))
  }
  return [bin, '/usr/bin', '/bin'].join(':')
}

function freePort() {
  return new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)) }) })
}

function run(command, args, env, timeout = budgetS * 1000) {
  return new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c; process.stdout.write(c) })
    child.stderr.on('data', (c) => { out += c; process.stderr.write(c) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? ok(out) : fail(new Error(`${command} ${args.join(' ')} exited ${code}`)) })
  })
}

async function api(base, path, body) {
  const r = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(budgetS * 1000),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${data.error || ''}`)
  return data
}

const seconds = (ms) => (ms / 1000).toFixed(1)
let env
let stub
let failed = false
try {
  stub = await stubModel()
  let spec = process.argv[2]
  if (!spec) {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }))
    spec = join(temp, packed.filename)
  } else if (!/^agentix-cli@(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(spec)) {
    spec = resolve(spec)
  }
  const [daemonPort, dashboardPort] = [await freePort(), await freePort()]
  env = {
    HOME: join(temp, 'home'), PATH: cleanPath(), TERM: 'dumb', CI: '1',
    // An empty npm cache, like a machine that never ran AgentX.
    npm_config_cache: join(temp, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    ANTHROPIC_BASE_URL: stub.url,
  }
  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'npm_config_registry']) {
    if (process.env[k]) env[k] = process.env[k]
  }
  mkdirSync(env.HOME)

  console.log(`First reply check: ${spec}, budget ${budgetS}s, ${process.platform}/${process.arch}, Node ${process.version}`)
  const t0 = Date.now()
  await run('npx', ['--yes', `--package=${spec}`, '--', 'agentx', 'start', '--no-open', '--port', String(daemonPort), '--dashboard-port', String(dashboardPort)], env)
  const tStarted = Date.now()

  const cfg = JSON.parse(readFileSync(join(dir, 'agentx.json'), 'utf8'))
  const agent = cfg.node.defaultAgent
  const board = `http://127.0.0.1:${dashboardPort}`
  const before = await api(board, `/api/admin/model-ready?agent=${agent}`)
  if (before.ready || before.need !== 'key') throw new Error(`Expected the chat to ask for a key, got ${JSON.stringify(before)}`)
  console.log(`The chat asks for a key: ${before.hint}`)
  const after = await api(board, '/api/admin/model-key', { agent, key: 'sk-ant-first-reply-test' })
  if (!after.ready) throw new Error(`Still not ready after pasting a key: ${JSON.stringify(after)}`)
  const reply = await api(board, '/api/admin/agent-chat', { agent, message: 'Hello! Who are you?' })
  const tReply = Date.now()

  if (!String(reply.content).includes(STUB_REPLY)) throw new Error(`Unexpected reply: ${JSON.stringify(reply)}`)
  if (!stub.requests()) throw new Error('The reply did not come from the model.')
  const total = tReply - t0
  console.log()
  console.log(`First reply: "${reply.content.trim()}"`)
  console.log(`  npx agentix-cli start: ${seconds(tStarted - t0)}s (download, install, config, daemon, dashboard)`)
  console.log(`  key + first message:   ${seconds(tReply - tStarted)}s`)
  console.log(`FIRST_REPLY_SECONDS=${seconds(total)} (budget ${budgetS}s)`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `First reply on ${process.platform}: **${seconds(total)} s** (start ${seconds(tStarted - t0)} s, budget ${budgetS} s)\n`, { flag: 'a' })
  }
  if (total > budgetS * 1000) throw new Error(`First reply took ${seconds(total)}s, over the ${budgetS}s budget.`)
} catch (e) {
  failed = true
  console.error(`First reply check failed: ${e.message}`)
  for (const log of ['daemon.log', 'board.log']) {
    const p = join(dir, '.agentx', log)
    if (existsSync(p)) console.error(`--- .agentx/${log} (last lines) ---\n${readFileSync(p, 'utf8').split('\n').slice(-40).join('\n')}`)
  }
} finally {
  // Stop what `start` left running in the background.
  for (const name of ['daemon.pid', 'board.pid']) {
    const p = join(dir, '.agentx', name)
    if (existsSync(p)) { try { process.kill(Number(readFileSync(p, 'utf8'))) } catch {} }
  }
  await new Promise((r) => setTimeout(r, 1000))
  stub?.server.close()
  rmSync(temp, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
