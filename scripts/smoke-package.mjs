// Installs the actual tarball or registry package with lifecycle scripts enabled.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root = process.cwd()
const temp = mkdtempSync(join(tmpdir(), 'agentx-package-smoke-'))
function run(command, args, cwd = temp) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: join(temp, 'cache'), npm_config_update_notifier: 'false' } })
}
try {
  let spec = process.argv[2]
  if (!spec) {
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root))
    spec = join(temp, packed.filename)
  } else if (!/^agentix-cli@(?:latest|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(spec)) {
    spec = resolve(spec)
  }
  writeFileSync(join(temp, 'package.json'), '{"name":"agentx-smoke","version":"1.0.0","private":true}')
  run('npm', ['install', '--no-audit', '--no-fund', '--foreground-scripts', spec])
  const installed = join(temp, 'node_modules', 'agentix-cli')
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(pkg.bin.agentx.replace(/^\.\//, ''), 'dist/cli.js')
  const executable = join(temp, 'node_modules', '.bin', 'agentx')
  assert.ok(run(executable, ['--version']).includes(pkg.version))
  for (const args of [['--help'], ['daemon', '--help'], ['desktop', '--help'], ['tui', '--help']]) {
    assert.ok(run(executable, args).includes('Usage:'))
  }
  // Native bindings can fail even when npm's best-effort postinstall exits 0.
  run(process.execPath, ['--input-type=module', '-e', `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(join(installed, 'package.json'))});const DB=require('better-sqlite3');const db=new DB(':memory:');if(db.prepare('select 1 as ok').get().ok!==1)throw Error('SQLite query failed');db.close()`])
  console.log(`Installed-package smoke passed: ${pkg.name}@${pkg.version} on ${process.platform}/${process.arch}, Node ${process.version}`)
} finally { rmSync(temp, { recursive: true, force: true }) }
