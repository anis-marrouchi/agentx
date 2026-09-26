# Run a health check

`agentx doctor` checks the most common reasons AgentX doesn't work, before you hit them: the wrong Node.js version, a broken `agentx.json`, a missing AI tool, keys that aren't set, agent folders that don't exist, and a daemon (the AgentX background service) that doesn't answer.

Doctor only checks. It doesn't install or repair anything; each problem it finds comes with a suggested fix.

## Run it from the terminal

1. **Terminal:** go to the folder that holds your `agentx.json`.
2. **Terminal:** run:
   ```sh
   agentx doctor
   ```
   In a source checkout, run `node dist/cli.js doctor` instead.
3. Read the report. Checks are grouped (**Environment**, **Config**, **Secrets**, **Workspaces**, **Runtime** and others). On a Mac with banners turned on, **Notifications** checks whether AgentX Helper is installed and allowed to show banners ([Get notified](../jobs/notifications.md#if-something-is-wrong)). Each line starts with a mark:
   - `✓` the check passed.
   - `!` a warning. Worth reading, but it doesn't stop AgentX.
   - `✗` an error. AgentX won't work properly until it's fixed.
4. Under a failed line, the line starting with `→` is the suggested fix. Apply it.
5. **Terminal:** run `agentx doctor` again until the last line says `All checks passed`, or only lists warnings.

A shortened example of the report:

```
  agentx doctor

  Environment
    ✓ Node.js 22.x.x
    ✓ npm on PATH

  Config
    ✓ agentx.json valid (1 agents, 0 schedules)

  Runtime
    ✓ Daemon healthy — 1 agents live, uptime 5m

  All checks passed (5).
```

## Options

- `agentx doctor --no-running` skips the check that the daemon answers. Use it when you stopped the daemon on purpose.
- `agentx doctor --json` prints the same checks in a format other programs can read, for example in an automated test.

Doctor exits with code 1 when there is at least one error, and 0 otherwise.

## Run it from the browser

The same checks are on the dashboard.

1. **Browser:** open `/admin/health` on your dashboard (for example `http://127.0.0.1:4202/admin/health`).
2. Select the **Doctor** tab.

<!-- Screenshot needed: the Doctor tab of the Health page (/admin/health). Not defined in docs/.scripts/capture.mjs yet. -->

## Check it worked

1. **Terminal:** run `agentx doctor`.
2. The last line reads `All checks passed (…)`, or `… warning(s). Review but not blocking.`

## If something is wrong

- **`command not found: agentx`:** AgentX isn't installed on this machine's path. In a source checkout, use `node dist/cli.js doctor`. Otherwise see [Install](../install.md).
- **`Node.js … AgentX requires Node 22.x`:** install Node.js 22, then run doctor again.
- **`agentx.json is not valid JSON`:** the detail line names the position of the mistake. Fix it, or restore the latest backup: each save from the dashboard leaves a copy named `agentx.json.bak.<number>` in the same folder.
- **`Daemon not reachable (not running?)`:** the daemon isn't running or can't be reached. Start it with `agentx daemon start --detach`, or add `--no-running` if it's stopped on purpose.
- **Everything passes but messages still get no reply:** follow [It's not answering](./its-not-answering.md).
