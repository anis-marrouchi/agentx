// Copies the skills the Claude Code plugin ships (plugins/agentx) from
// skills/, which stays the source of truth. Claude Code copies a plugin
// into its cache, so the plugin holds real files rather than links.
// `--check` changes nothing and fails when a copy is out of date.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACK_SKILLS = ['agentx-node', 'agentx-contribute', 'daemon-ops']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, 'plugins/agentx/skills')

function files(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath ?? entry.path, entry.name).slice(dir.length + 1))
    .sort()
}

export function staleSkills() {
  const shipped = existsSync(target) ? readdirSync(target).sort() : []
  const stale = shipped.filter(name => !PACK_SKILLS.includes(name))
  for (const name of PACK_SKILLS) {
    const from = join(root, 'skills', name)
    const to = join(target, name)
    const a = files(from)
    const b = files(to)
    const same = a.length === b.length && a.every((file, i) =>
      file === b[i] && readFileSync(join(from, file)).equals(readFileSync(join(to, file))))
    if (!same) stale.push(name)
  }
  return stale
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stale = staleSkills()
  if (process.argv.includes('--check')) {
    if (stale.length) {
      console.error(`Plugin skills out of date: ${stale.join(', ')}. Run: node scripts/sync-plugin-skills.mjs`)
      process.exitCode = 1
    } else console.log(`Plugin skills match skills/ (${PACK_SKILLS.length}).`)
  } else {
    rmSync(target, { recursive: true, force: true })
    for (const name of PACK_SKILLS) cpSync(join(root, 'skills', name), join(target, name), { recursive: true })
    console.log(`Copied ${PACK_SKILLS.length} skills into plugins/agentx/skills.`)
  }
}
