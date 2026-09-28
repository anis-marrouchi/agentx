// Pure helpers for the daily vote count (#281). No network, no files: the
// runner in contrib-votes.mjs fetches, this module decides and renders.

export const README_START = '<!-- most-requested:start -->'
export const README_END = '<!-- most-requested:end -->'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Count the votes on one issue. A vote is a 👍 reaction on the issue body.
 * Not counted: the issue author, bots, and accounts younger than
 * `minAccountAgeDays` when they reacted.
 *
 * @param issue      { author: string }
 * @param reactions  [{ login, type, createdAt }]   (type is the GitHub user type)
 * @param accounts   Map login → account createdAt (ISO string)
 */
export function countVotes(issue, reactions, accounts, { minAccountAgeDays }) {
  const voters = new Set()
  for (const r of reactions) {
    const login = r.login
    if (!login || voters.has(login)) continue
    if (login === issue.author) continue
    if (r.type === 'Bot' || login.endsWith('[bot]')) continue
    const created = accounts.get(login)
    if (!created) continue
    const ageDays = (Date.parse(r.createdAt) - Date.parse(created)) / DAY_MS
    if (ageDays < minAccountAgeDays) continue
    voters.add(login)
  }
  return voters.size
}

/** Issues that take part in voting: not excluded by label (bugs go by severity). */
export function isVotable(issue, { excludeLabels }) {
  return !issue.labels.some((l) => excludeLabels.includes(l))
}

/** Most votes first; ties go to the older issue (lower number). */
export function rank(issues) {
  return issues.filter((i) => i.votes > 0).sort((a, b) => b.votes - a.votes || a.number - b.number)
}

function line(i) {
  return `| ${i.votes} | [#${i.number}](${i.url}) | ${i.title.replace(/\|/g, '\\|')} |`
}

/** The README block (without markers): top N with at least minVotes. */
export function renderReadmeBlock(ranked, { minVotes, topN }, pageUrl) {
  const top = ranked.filter((i) => i.votes >= minVotes).slice(0, topN)
  const out = []
  if (top.length) {
    out.push('| Votes | Issue | Request |', '| ---: | --- | --- |', ...top.map(line))
  } else {
    out.push(`No request has ${minVotes} votes yet. Yours could be the first: give a 👍 to the issues you care about.`)
  }
  out.push('', `[Full ranked list](${pageUrl}) · [How voting works](https://agentx-docs.pages.dev/guides/contribute)`)
  return out.join('\n')
}

/** Replace the text between the README markers. Throws if the markers are missing. */
export function replaceBlock(text, block) {
  const start = text.indexOf(README_START)
  const end = text.indexOf(README_END)
  if (start < 0 || end < start) throw new Error(`README markers ${README_START} … ${README_END} not found`)
  return `${text.slice(0, start + README_START.length)}\n${block}\n${text.slice(end)}`
}

/** The full docs page, regenerated every run. */
export function renderPage(ranked, settings, date) {
  const rows = ranked.length
    ? ['| Votes | Issue | Request |', '| ---: | --- | --- |', ...ranked.map(line)].join('\n')
    : 'No request has a counted vote yet.'
  return `# Most requested

This page lists open requests ranked by community votes. A GitHub Action counts the votes every day; the list last changed on ${date}. Votes help guide the roadmap, and maintainers make the final decisions and explain them.

Bugs are not on this list. They are fixed in order of severity, as described in the [maintainer runbook](https://github.com/anis-marrouchi/agentx/blob/main/.github/maintainer/TRIAGE.md).

${rows}

## How votes are counted

1. A vote is a 👍 reaction on the issue itself. Comments do not count, so discussion stays free.
2. The issue author's own reaction is not counted.
3. Reactions from bots are not counted.
4. Reactions from accounts younger than ${settings.minAccountAgeDays} days at the time of the reaction are not counted.
5. The README shows the top ${settings.topN} requests with at least ${settings.minVotes} votes.

The numbers live in \`contrib/voting.json\`. To vote, see [Contribute to AgentX](../guides/contribute.md).

## Check it worked

1. In the browser, open the **Actions** tab of the repository.
2. Open the latest **Count votes** run and check that it is green and ran today or yesterday.
3. Compare a count on this page with the 👍 count on that issue. It can be lower, because some reactions are not counted.

## If something is wrong

- **The Count votes run failed.** Open the run and read the failing step; a maintainer can start it again with **Run workflow**.
- **A count looks too low.** Check whether some of the reactions come from the author, a bot, or a new account; those are not counted.
`
}
