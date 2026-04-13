# Kanban boards

AgentX ships with a visual kanban dashboard — six columns (Triage, To Do, Doing, On Hold, Review, Done), drag-and-drop card moves that write through to your source of truth (currently: GitLab), and a filter bar modelled on GitLab's issue board.

Phase 1 supports GitLab only; backlog-file and wiki sources come later.

## Quick start

Add a `boards` block and (optionally) a `dashboard` block to `agentx.json`:

```jsonc
{
  "channels": {
    "gitlab": {
      "enabled": true,
      "host": "https://gitlab.noqta.tn",
      "token": "${GITLAB_TOKEN}",
      "agentMappings": [
        { "agentId": "devops-agent", "gitlabUsernames": ["devops-bot"] },
        { "agentId": "marketing-agent", "gitlabUsernames": ["marketing-bot"] }
      ]
    }
  },

  "boards": [
    {
      "id": "mtgl-main",
      "name": "MTGL Engineering",
      "source": {
        "type": "gitlab",
        "projects": ["mtgl/mtgl-system-v2"]
      },
      "primaryToolLabel": "team:platform",
      "labels": [
        { "name": "priority:p0", "color": "#ef4444" },
        { "name": "priority:p1", "color": "#f59e0b" },
        { "name": "team:platform", "color": "#6366f1" }
      ],
      "timeRangeDays": 30,
      "reconciliation": {
        "enabled": true,
        "staleDoingMinutes": 45,
        "action": "badge"
      }
    }
  ],

  "dashboard": {
    "enabled": true,
    "port": 4202,
    "bind": "127.0.0.1"
  }
}
```

Then:

```bash
agentx board list       # sanity-check configuration
agentx board serve      # open http://127.0.0.1:4202
```

## Board config reference

| Field | Default | Notes |
|---|---|---|
| `id` | — | Lowercase slug, required. Stable URL path. |
| `name` | — | Human display name. |
| `source.type` | `"gitlab"` | Only `gitlab` in Phase 1. |
| `source.projects` | — | Array of `group/project` paths (at least one). |
| `primaryToolLabel` | — | If set, ANDed into every list query as a baseline filter. |
| `labels[]` | `[]` | Catalog surfaced as filter chips. Each entry: `name`, `color` (`#RRGGBB`), optional `description`. |
| `columns[]` | six defaults (Triage → Done) | If customized, must have exactly 6 entries and the six column IDs. Each entry's `mapsToLabel` is the GitLab label written when a card enters that column. |
| `timeRangeDays` | `30` | How far back the `listAll` query reaches. |
| `reconciliation.enabled` | `true` | Compute stale-doing badges (Phase 3). |
| `reconciliation.staleDoingMinutes` | `45` | Idle threshold for yellow badge. |
| `reconciliation.respectLunchBreak` | `true` | Don't flag stale during `business.orgChart.<agent>.schedule.lunch`. |
| `reconciliation.respectSchedule` | `true` | Don't flag stale outside on-clock hours. |
| `reconciliation.action` | `"badge"` | `"badge"` (default) or `"notify"`. `auto-demote` is intentionally not supported. |

## Dashboard config reference

| Field | Default | Notes |
|---|---|---|
| `enabled` | `false` | Must be `true` for `agentx board serve` to start. |
| `port` | `4202` | HTTP port. |
| `bind` | `"127.0.0.1"` | Loopback by default. Set to `"0.0.0.0"` only behind a trusted proxy. |
| `token` | — | If set, all `/api/*` requests require `Authorization: Bearer <token>`. The HTML shell is served unconditionally; the browser prompts once and caches in `sessionStorage`. |

## GitLab prerequisites

- A Personal Access Token with `api` scope, stored as `GITLAB_TOKEN` in `.env` and referenced via `${GITLAB_TOKEN}` in `agentx.json`.
- Every agent that can own cards needs a `channels.gitlab.agentMappings[]` entry mapping to its GitLab username(s). Issue assignees are resolved through this map for the reconciliation badge.
- Your GitLab project must have the six default labels (Triage, To Do, Doing, On Hold, Review, Done) — or custom labels referenced from your `columns[].mapsToLabel`. The board never creates labels.

## How cards move

- Drag a card from column A to column B → the dashboard issues `PATCH /api/boards/:id/items/:itemId/move` with `{from, to}`.
- The GitLab API receives `PUT /projects/:id/issues/:iid?add_labels=<toLabel>&remove_labels=<fromLabel>`.
- If the GitLab call fails (token revoked, network timeout, 4xx, 5xx) the card snaps back to its original column and a toast shows the error.
- Every successful write appends one line to `.agentx/board-audit.jsonl` (`{ts, actor, action, boardId, itemId, payload}`) for forensics.

## Security posture

- Default bind is `127.0.0.1`. If you set `bind: "0.0.0.0"`, you **should** also set a `token` — otherwise writes are unauthenticated and the audit log is the only defense.
- Write routes (`PATCH`, `POST`) require an `X-Requested-With: agentx-board` header — defense-in-depth against naive cross-origin form submits.
- Only labels that appear in `columns[].mapsToLabel` can ever be written. The board can't mutate arbitrary GitLab labels.
- Only projects listed in each board's `source.projects` can ever receive writes. One board can't mutate another board's projects.

## Known limits (Phase 1)

- **Read + drag only.** Card create, assign, and the "AgentX assist" button arrive in Phase 2.
- **No live updates.** The page doesn't auto-refresh; reload the tab to pick up externally-made changes. SSE push lands in Phase 3.
- **Reconciliation badges are not computed yet** — Phase 3.
- **GitLab only.** Backlog-file boards arrive in Phase 2.
- **Desktop only.** Minimum viewport is 1024 px.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `agentx board serve` exits with "No boards configured" | Add a `boards` entry to `agentx.json`. |
| Columns load but empty | Check `timeRangeDays` (default 30). Broaden it or verify the projects actually have recent activity. |
| Card drag fails with "source does not support transitions" | You're looking at a backlog/wiki board (Phase 2). Phase 1 only supports GitLab transitions. |
| Drag snaps back with "GitLab 401" | Token lacks `api` scope or is expired. Rotate in `.env` and restart. |
| Drag snaps back with "GitLab 403" | Token user doesn't have permission to modify labels on the issue. |
| Port 4202 already in use | Change `dashboard.port` or pass `--port` to `agentx board serve`. |
