// Read-only collection. Partial failures are explicit; no comments or mutations.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
const repo = 'anis-marrouchi/agentx'
const sources = {}
async function collect(name, args, limit) {
  try {
    const { stdout } = await exec('gh', args, { timeout: 45000, maxBuffer: 8 * 1024 * 1024 })
    const data = JSON.parse(stdout)
    sources[name] = { ok: true, possiblyTruncated: Array.isArray(data) && data.length >= (limit ?? Infinity), data }
  } catch (error) {
    // Do not echo stderr: authentication errors can contain local/private details.
    sources[name] = { ok: false, error: `Collection failed (${error.code ?? 'unknown'}); inspect locally` }
  }
}
await Promise.all([
  collect('repository', ['repo', 'view', repo, '--json', 'nameWithOwner,defaultBranchRef,hasDiscussionsEnabled']),
  collect('issues', ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,labels,assignees,createdAt,updatedAt'], 100),
  collect('pullRequests', ['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,title,url,isDraft,labels,assignees,updatedAt,headRefName,baseRefName'], 100),
  collect('runs', ['run', 'list', '-R', repo, '--limit', '40', '--json', 'databaseId,url,name,headBranch,headSha,event,status,conclusion,createdAt,updatedAt'], 40),
  collect('releases', ['release', 'list', '-R', repo, '--limit', '10', '--json', 'tagName,publishedAt,isDraft,isPrerelease'], 10),
  collect('discussions', ['api', 'graphql', '-f', 'query=query { repository(owner:"anis-marrouchi", name:"agentx") { discussions(first:20, orderBy:{field:UPDATED_AT,direction:DESC}) { pageInfo { hasNextPage endCursor } nodes { number title url updatedAt answerChosenAt category { name } } } } }']),
])
try {
  const response = await fetch('https://registry.npmjs.org/agentix-cli', { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error('registry unavailable')
  const data = await response.json()
  sources.npm = { ok: true, data: { latest: data['dist-tags']?.latest, publishedAt: data.time?.[data['dist-tags']?.latest] } }
} catch { sources.npm = { ok: false, error: 'Registry unavailable; publication status unknown' } }
console.log(JSON.stringify({ collectedAt: new Date().toISOString(), repository: repo, complete: Object.values(sources).every(s => s.ok), sources }, null, 2))
if (Object.values(sources).some(s => !s.ok)) process.exitCode = 1
