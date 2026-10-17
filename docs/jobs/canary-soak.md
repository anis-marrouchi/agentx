# Soak a release before it reaches a second machine

![A release runs on this machine for two hours. If it stays healthy, agentx daemon deploy copies the same release to the second machine, which restarts when idle. A release that is still soaking or failed is refused.](/diagrams/canary-soak.svg)

A **release** is one commit of AgentX: the short code that `git` gives it, such as `1a2b3c4`. When you run AgentX on two machines, a broken release should break only the first one. The canary soak makes sure of that.

With the soak switched on, `agentx daemon deploy` copies a release to the second machine only after that same release has run on this machine's daemon for a while (2 hours unless you change it) without new trouble. The daemon is the AgentX program that keeps running in the background.

During the soak, AgentX counts, from what it already records:

- **restarts:** times the daemon was restarted on this release, after the restart that started the soak.
- **crashes:** times it stopped without being asked to (a crash, or a forced kill).
- **crash loop:** several restarts close together (`resume.crashLoop`: 3 within 10 minutes unless you change it).
- **failed tasks:** tasks that ended with an error or ran out of time.
- **error rate:** the share of failed tasks, compared with the release that ran before. This check is skipped when there were fewer than 10 tasks to compare.

When the soak time is up and every check is within its limit, the release is marked `soak: passed`. When a check goes over its limit, the release is marked `failed` right away, and the deploy says which check failed. The first pass or fail is kept, so trouble after the soak does not undo a pass.

The soak is off unless you switch it on. While it is off, `agentx daemon deploy` works exactly as before.

## Switch the soak on

1. **Terminal:** go to the folder that holds `agentx.json` and the AgentX code you deploy from.
2. **Editor:** add this to `agentx.json`:
   ```json
   "quality": {
     "canary": { "enabled": true }
   }
   ```
3. **Terminal:** restart the daemon so it records which release it runs: `agentx daemon restart --when-idle`.

The settings and their limits are listed under [`quality`](/reference/config-automation#quality).

## Deploy a release

1. **Terminal:** commit your changes. A release is a commit, so a folder with uncommitted changes is refused.
2. **Terminal:** build and restart this machine's daemon on it: `pnpm build`, then `agentx daemon restart --when-idle`. The soak starts now.
3. **Terminal:** see how far along it is:
   ```sh
   agentx daemon soak
   ```
   It prints the release, `soak: soaking`, `passed` or `failed`, the minutes left, and each check with a ✓ or ✗.
4. **Terminal:** once it says `passed`, try the deploy without changing anything:
   ```sh
   agentx daemon deploy second-host --dry-run
   ```
   It prints `✓ Canary soak: 1a2b3c4: soak passed` and the commands it would run.
5. **Terminal:** deploy for real: `agentx daemon deploy second-host --restart`. AgentX builds the release again from the same commit, so the second machine gets exactly what soaked here.

Replace `second-host` with the name or address of your second machine.

## Deploy anyway (override)

Use this only when waiting is worse than the risk, for example to ship the fix for an outage.

1. **Terminal:** run the deploy with a reason:
   ```sh
   agentx daemon deploy second-host --override-soak "fix for the login outage"
   ```
2. AgentX prints `⚠ Canary soak: soak override (…)`, then deploys.
3. The override is written, with your reason, the release, the machine and your user name, to `.agentx/canary/events.jsonl`.

A `--dry-run` with `--override-soak` shows what would happen and writes nothing.

## See the soak history

1. **Terminal:** run `agentx daemon soak --history`. It prints how many releases passed, failed and were blocked, then one line per release.
2. **Terminal:** add `--since 7` for the last 7 days only, or `--json` for output that other tools, such as a weekly quality report, can read.

## Check it worked

1. **Terminal:** run `agentx daemon soak` right after a restart on a new commit. It says `soak: soaking` with about 120 minutes left.
2. **Terminal:** run `agentx daemon deploy second-host --dry-run`. It prints `✗ Canary soak: soaking: … min left` and changes nothing.
3. After the soak time, run the same two commands again. They say `passed` and `✓ Canary soak: … soak passed`.

## If something is wrong

- **`has not run on this daemon yet`:** this machine's daemon has not been restarted on that commit. Build, then `agentx daemon restart --when-idle`.
- **`has uncommitted changes, so it is not a release`:** commit first, then restart this machine's daemon on the new commit.
- **`interrupted: replaced after …`:** another release was started here before the soak ended. Restart the daemon on the release you want to deploy, and wait again.
- **`failed: crashes (1 unclean stop(s) …)`:** the daemon stopped without being asked to during the soak. Read `agentx daemon logs`, fix the cause, commit, and soak the new release.
- **`failed: failed-tasks (task history unavailable …)`:** AgentX could not read its task history in `.agentx/db.sqlite`. Run `agentx doctor`. The soak cannot pass without it.
- **`failed: error-rate (…)`:** more tasks failed than on the release before. Look at the failed tasks on the dashboard, fix the cause, and soak a new release.
- **The deploy is not gated at all:** check that `quality.canary.enabled` is `true` in the `agentx.json` of the folder you deploy from, or pass that file with `--config`.
- **A release passed, but you want to block it after all:** the first decision is kept in `.agentx/canary/releases.json`. Deploy a newer release instead.
