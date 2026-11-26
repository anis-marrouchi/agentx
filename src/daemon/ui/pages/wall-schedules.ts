// Hub › Schedules as a table (#2101 P10, mock R7): name, project, next run
// and last result in columns, and a failed last run said on its row, not
// only inside the fold. Pure helpers, shipped to the browser with
// injectFns() and called from jobsPageHtml() (wall-pages.client.ts).

/** The project a job serves: its home issue, shortened, else its goal id. */
export function wsProject(j: { home?: string; goal?: string }): { label: string; href: string } {
  const home = typeof j.home === "string" ? j.home.trim() : ""
  if (home) {
    // A forge link: owner/repo#12 for an issue or MR, else the path.
    const m = /^https?:\/\/[^/]+\/(.+?)\/(?:-\/)?(?:issues|merge_requests|pull)\/(\d+)/.exec(home)
    if (m) return { label: m[1] + "#" + m[2], href: home }
    if (/^https?:\/\//.test(home)) return { label: home.replace(/^https?:\/\/[^/]+\//, "").slice(0, 60), href: home }
    return { label: home.slice(0, 60), href: "" }
  }
  const goal = typeof j.goal === "string" ? j.goal.trim() : ""
  return goal ? { label: goal, href: "" } : { label: "", href: "" }
}

/** The last run as one cell: worked / failed / timed out, and when. */
export function wsLast(
  run: { status?: string; at?: string; summary?: string } | null | undefined,
  esc: (s: string) => string,
  when: (t: number) => string,
): { html: string; failed: boolean; why: string } {
  if (!run || !run.status) return { html: '<span class="wsc__none">No run yet</span>', failed: false, why: "" }
  const failed = run.status === "failed" || run.status === "timeout" || run.status === "missed"
  const word = run.status === "success" ? "Worked" : run.status === "timeout" ? "Timed out" : run.status === "failed" ? "Failed"
    : run.status === "missed" ? "Missed" : run.status === "held" ? "Held, retry waiting"
    : run.status === "skipped" ? "Skipped, nothing to do" : run.status
  const t = run.at ? Date.parse(run.at) : NaN
  const why = failed && run.summary ? String(run.summary).split("\n")[0].slice(0, 160) : ""
  return {
    html: '<span class="wsc__last' + (failed ? " is-err" : run.status === "success" ? " is-ok" : "") + '">' + esc(word) + (isNaN(t) ? "" : " <small>" + when(t) + "</small>") + "</span>",
    failed,
    why,
  }
}

/** The table head row, above each machine's rows. */
export function wsHeadHtml(): string {
  return '<div class="wjb__head" aria-hidden="true"><span>Schedule</span><span>Project</span><span>Next run</span><span>Last result</span><span>Last 7</span><span></span></div>'
}
