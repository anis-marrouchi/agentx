# agentx doctor

Pre-flight health check. Catches the common "why isn't it working" reasons before you hit them at runtime.

```bash
agentx doctor              # interactive, colored
agentx doctor --json       # machine-readable for CI
agentx doctor --no-running # skip the live daemon probe
```

## What it checks

**Environment**

- Node.js version (20+ required)
- `npm` on PATH
- `claude` CLI presence (advisory unless a `claude-code` agent references it)
- `codex` CLI presence (advisory unless a `codex-cli` agent references it)

**Config**

- `agentx.json` exists + parses as JSON
- Full schema validation via the same loader the daemon uses
- Promotes the Claude CLI check to `fail` if any agent is `tier: claude-code`
- Promotes the Codex CLI check to `fail` if any agent is `tier: codex-cli`

**Secrets**

- Scans every `${VAR}` reference in `agentx.json`
- Verifies each one is set in `.env` OR `process.env`
- Fails on missing refs, warns on set-but-empty refs

**Workspaces**

- Every `agents.<id>.workspace` directory exists on disk

**Runtime** (unless `--no-running`)

- Daemon reachable on `dashboard.daemonUrl` (default `http://127.0.0.1:18800`)
- Reports live agent count + uptime on success

## Exit codes

- `0` — clean or warnings only
- `1` — one or more errors

So `agentx doctor --no-running && agentx daemon start` is a safe-to-paste pre-flight.

## --json shape

```json
{
  "checks": [
    { "severity": "ok" | "warn" | "fail", "group": "Environment", "title": "...", "detail": "...", "fix": "..." }
  ],
  "summary": { "errors": 0, "warnings": 1, "ok": 7 }
}
```

Stable enough for CI. Severity values won't change; new check groups may be added.

## Typical output

```
  agentx doctor

  Environment
    ✓ Node.js 22.22.0
    ✓ npm on PATH
    ✓ claude CLI 2.1.112

  Config
    ✓ agentx.json valid (2 agents, 9 schedules)

  Secrets
    ✗ 1 env var(s) referenced in agentx.json but missing
      ANTHROPIC_API_KEY
      → Add to .env — e.g. ANTHROPIC_API_KEY=<value>

  Workspaces
    ✓ All agent workspace folders exist

  1 error. Fix the error and rerun.
```
