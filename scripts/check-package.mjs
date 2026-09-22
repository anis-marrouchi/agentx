import { execFileSync } from 'node:child_process'
const [pkg] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))
const files = new Set(pkg.files.map(f => f.path))
for (const required of ['dist/cli.js', 'scripts/postinstall.mjs', 'apps/mac-voice/build.sh', 'apps/mac-voice/Resources/Info.plist', 'apps/mac-helper/build.sh']) {
  if (!files.has(required)) throw new Error(`Missing package file: ${required}`)
}
for (const file of files) {
  if (/(^|\/)(\.env(?:\..*)?|agentx\.json|\.agentx|\.agentx-demo|notes|output)(\/|$)/.test(file))
    throw new Error(`Runtime/private file in package: ${file}`)
}
console.log(`Verified ${files.size} packed files for ${pkg.name}@${pkg.version}`)
