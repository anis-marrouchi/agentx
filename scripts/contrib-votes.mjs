// Daily vote count (#281): rank open requests by 👍 votes, rewrite the
// "Most requested" block in the README and the full ranked docs page.
//
// Settings come from contrib/voting.json. Needs GITHUB_TOKEN (read access).
// Usage: node scripts/contrib-votes.mjs [--repo owner/name] [--dry-run]
import { readFile, writeFile } from 'node:fs/promises'
import { countVotes, isVotable, rank, renderPage, renderReadmeBlock, replaceBlock } from './contrib-votes-lib.mjs'

const args = process.argv.slice(2)
const repo = args.includes('--repo') ? args[args.indexOf('--repo') + 1] : 'anis-marrouchi/agentx'
const dryRun = args.includes('--dry-run')
const token = process.env.GITHUB_TOKEN
const PAGE_URL = 'https://agentx-docs.pages.dev/community/most-requested'

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`)
  return res.json()
}

async function all(path) {
  const out = []
  for (let page = 1; ; page++) {
    const batch = await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    out.push(...batch)
    if (batch.length < 100) return out
  }
}

const settings = JSON.parse(await readFile('contrib/voting.json', 'utf8'))
const accounts = new Map()

const open = (await all(`/repos/${repo}/issues?state=open`))
  .filter((i) => !i.pull_request)
  .map((i) => ({
    number: i.number,
    title: i.title,
    url: i.html_url,
    author: i.user?.login,
    labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
    thumbs: i.reactions?.['+1'] ?? 0,
  }))
  .filter((i) => isVotable(i, settings))

const counted = []
for (const issue of open) {
  if (issue.thumbs === 0) continue
  const reactions = (await all(`/repos/${repo}/issues/${issue.number}/reactions?content=%2B1`)).map((r) => ({
    login: r.user?.login,
    type: r.user?.type,
    createdAt: r.created_at,
  }))
  for (const r of reactions) {
    if (!r.login || accounts.has(r.login) || r.type === 'Bot') continue
    accounts.set(r.login, (await gh(`/users/${encodeURIComponent(r.login)}`)).created_at)
  }
  counted.push({ ...issue, votes: countVotes(issue, reactions, accounts, settings) })
}

const ranked = rank(counted)
const today = new Date().toISOString().slice(0, 10)
const readme = replaceBlock(await readFile(settings.readme, 'utf8'), renderReadmeBlock(ranked, settings, PAGE_URL))
// Keep the old date (and skip the commit) when the ranking itself did not change.
const oldPage = await readFile(settings.page, 'utf8').catch(() => '')
const oldDate = oldPage.match(/last changed on (\d{4}-\d{2}-\d{2})/)?.[1]
const page = oldDate && renderPage(ranked, settings, oldDate) === oldPage ? oldPage : renderPage(ranked, settings, today)

console.log(`Counted votes on ${counted.length} of ${open.length} votable open issues; ${ranked.length} ranked.`)
for (const i of ranked.slice(0, settings.topN)) console.log(`  ${i.votes}  #${i.number}  ${i.title}`)
if (dryRun) process.exit(0)
await writeFile(settings.readme, readme)
await writeFile(settings.page, page)
