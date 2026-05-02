# Business

Path: `/admin` → **Business** tab

Where you describe how your *organisation* maps onto agentx. Three small tables — org chart, projects, contact map — that together let the daemon answer "who reports to whom?", "which client owns this work?", and "when this random Telegram chat sends a message, who is it for?". If the dashboard ever shows mystery work attributed to "internal," this is the page that fixes it.

This tab is the visual mirror of the `agentx business` CLI subcommands. Anything you can do here, you can do from the terminal — and vice versa. The data is the same; only the editor is different.

## What you'll see

Three sections stacked vertically, each independently editable:

- **Org chart** — one row per agent. Columns: `agentId`, `role` (free text — "engineer," "PM," "support"), `reportsTo` (another agentId, or empty for the root), `schedule` (working days, start time, end time). The schedule drives PM-gating (no work approved outside hours) and feeds the activity graph so dashboards know whose hours to count. Most operators only need to fill `role` and `reportsTo` — schedule is optional and defaults to "always on."
- **Projects** — one row per project. Columns: `id` (the stable string you reference everywhere — typically `owner/repo` for a code project, or any unique slug for non-code work), optional `pm` (the agentId that gates approvals on this project), optional `client` (the client name, used by the activity graph to attribute work). Both `pm` and `client` are optional — leaving them blank just means "no PM gate" and "internal work" respectively.
- **Contact map** — one row per external chat. Columns: the channel-specific identifier (Telegram `chatId`, WhatsApp `senderId`, Slack `username`, etc.), `client` (which client this chat belongs to), `project` (which project they're talking about). Without a row here, free-text channels fall into the "internal" catch-all bucket and your activity reports look meaningless.

Every row has Edit and Delete. Add rows via the **+** button at the top of each section. Empty sections show a one-line "no entries yet" message instead of a blank table.

## What you can do

- Add, edit, or remove rows in any of the three tables.
- Reassign a project's PM by editing the `pm` column inline.
- Map a new external chat to a client without writing any JSON.
- See at a glance which projects have no PM (the `pm` cell is blank — those are not gated).
- See at a glance which chats are still uncategorised — search for blank `client` cells; those are still falling into "internal."
- Bulk-import the entire business config by pasting JSON into [Admin → Advanced](./admin) (the Advanced tab is escape-hatch territory; only use it when the form-based editor here doesn't cover what you need).

Saves go through the same `applyConfigMutation` pipeline as every other admin tab: write to `agentx.json`, run Zod validation, then notify the daemon. **But:** business config is read by the daemon at startup and only re-read on a full reload. After saving, hit the **Reload daemon** button at the top of the page (or restart the daemon) for the change to take effect. Without a reload, the activity graph and PM gate keep using the old values — this is the single most common gotcha on this tab.

## Common tasks

1. **"Onboard a new project under client Acme."**
   Projects → **+** → `id` = `acme/website`, `client` = `Acme`, `pm` = `alice`. Save. Reload. From now on, work tagged `acme/website` shows up under Acme on the activity graph, and any approval-gated action waits on alice.

2. **"Map this Telegram group to client Acme so it stops showing as 'internal'."**
   Contact map → **+** → kind `telegram`, identifier = the chatId (find it in [Health → Routing](./health) on a recent message), `client` = `Acme`, `project` = `acme/website`. Save. Reload. The next message from that chat attributes to Acme.

3. **"Wire the PM gate for project `acme/website`."**
   Projects → edit row `acme/website` → set `pm` = the agentId of the person who should approve. Save. Reload. Now any approval-required action on this project waits for that agent's sign-off.

4. **"Update someone's working hours after a schedule change."**
   Org chart → edit their row → adjust `schedule.days`, `schedule.start`, `schedule.end`. Save. Reload. PM-gating now respects the new window.

5. **"Remove an agent from the org entirely."**
   Org chart → delete the row. The agent itself isn't deleted — it just no longer has a position in the org. Re-add to the [Agents tab](./admin) if you also want to retire the agent definition.

6. **"Audit who reports to whom."**
   Open the Org chart section, sort by `reportsTo`. Anyone with the same `reportsTo` value is a peer; anyone with empty `reportsTo` is at the root. The page doesn't draw a tree, but the sort gets you 80% of the way.

7. **"Find every chat that's still uncategorised."**
   Contact map → sort by `client` ascending. Blank cells float to the top — those are the chats agentx is still putting into the "internal" bucket. Map them, save, reload.

8. **"Mass-update a client rename (Acme → Acme Corp)."**
   The form-based editor only changes one row at a time. For a global rename, use the CLI: `agentx business project list | jq` to find every project with `client=Acme`, then `agentx business project add` over each with the new name. Reload once at the end.

## Troubleshooting

- **"I added a project but the activity graph still shows 'internal'."** You forgot the reload step. Business config is loaded once at startup. Hit **Reload daemon** at the top of the tab (or run `systemctl restart agentx`) and the graph picks up the new project on the next message.
- **"PM gate isn't gating."** Two common causes: the project row has no `pm` set (it's optional, so absence means "no gate"), or the `INTENT_PM_GATE_ENABLED` env var is `false`. Check the resolved value in [Admin → Advanced](./admin) at the bottom of the page.
- **"Contact map row is there but the chat still attributes to internal."** The identifier in the row doesn't exactly match what the channel sends. Telegram chatIds are signed integers (negative for groups); WhatsApp senderIds include the `@s.whatsapp.net` suffix. Look at the actual identifier in [Health → Routing](./health) and copy it verbatim.
- **"Schedule field rejects my times."** The form expects 24-hour `HH:MM`. `09:00` works; `9am` does not.
- **"Save returns 401."** `dashboard.token` is set but the request lacks a `dashboard:admin` token. Mint one in [Admin → Tokens](./admin), paste it into the dashboard's token field, retry.
- **"Validation failed: business.projects[3].id"** — Project ids must be unique and non-empty. The error path tells you exactly which row; check that you didn't paste a duplicate slug.
- **"Reloaded the daemon but the activity graph still doesn't show the new client."** The graph caches its layer separately from the live config. Either wait for the graph's own polling interval (a few minutes) or hit the **Refresh graph** button at the top of [Graph](./graph).

## How the three tables interact

These aren't independent — they form a small graph.

- **Org chart** answers "who is this agent and where do they sit?"
- **Projects** answers "what work do we do, and who owns approvals on it?"
- **Contact map** answers "this external chat is whose, and about what?"

When a Telegram message arrives, the daemon resolves: contact map → which client + project → which PM (from projects) → whose schedule applies (from org chart). If any link in that chain is missing, the work falls back to "internal" and PM-gating doesn't apply. The fastest way to debug a misattribution is to walk the chain backwards from the activity graph entry.

## CLI parity

- `agentx business show` — print the entire current business config.
- `agentx business orgchart add | remove | list` — manage the org chart table.
- `agentx business project add | remove | list` — manage the projects table.
- `agentx business contact add | remove | list` — manage the contact map table.

CLI mutations also require a daemon reload to take effect (`POST /reload` or restart). The CLI commands print a reminder when this is needed.
