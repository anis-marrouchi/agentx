# Org chart editing: one editor, add-agent, and a chat path (#1678)

Status: **plan only.** The issue says "build nothing until Anis says go", so
this note is the deliverable for now. It maps each point of the proposal to
the code on `main` (0.200.0) and splits the work into two PRs.

## What is already there (and what the issue missed)

| Piece | Where | Note |
|---|---|---|
| Checked edit, all three relation types, people | `src/business/org-edit.ts` `applyOrgEdit` | Refuses cycles, self-links, unknown members, a second boss, acts-for in the wrong direction. Plain sentences. |
| Route, owner only | `src/daemon/admin-panel.ts` `POST /api/admin/org/chart` → `editOrgChart` (403 for non-owners) | Writes with a backup via `mutateAgentxConfig`. |
| Read model | `GET /api/admin/org` → `getOrg`: `setup`, `canEdit`, `choices` (owner only) | |
| Editor UI | `src/daemon/ui/pages/org-setup.ts` `orgEditHtml` + `orgConfirmFor` | Self-contained functions shipped with `injectFns`, so they can run in another page. |
| **Live apply** | `src/daemon/index.ts` reload step 6b: `orgShape()` diff → `business.org.replaceWith()` | Already shipped with #1420. Escalation sees the new chart with no restart. Only schedules / day cycle still read config at start. |
| Old free-text form | `src/daemon/ui/pages/wall-settings-business.client.ts` (`biz-org` form, `POST business/orgchart`) | `reportsTo` only, typed ids, and the stale "Restart the daemon" line. |
| Add agent | `POST /api/admin/agents` → `addAgent` | No org step. |
| Approval cards | `agentx_approval` → `src/approvals/tool.ts` | The agent gets the decision back and acts itself; nothing runs on "yes" server-side today. |

So point 4 of the proposal ("No restart") is mostly a copy fix: the org part
already reloads live. The Business header must say which parts still need a
restart (schedules) instead of "restart after a change here".

## PR (a): UI, points 1–4

### 1. One editor in the Business tab

- Move the editor out of `/org` into a shared module the Hub can splice in:
  keep `orgEditHtml` / `orgConfirmFor` in `org-setup.ts`, and add the click
  handler (today inline in `ui/pages/org.ts` around line 273–300) to the same
  file as `orgEditBind(root, reload)`, also `injectFns`-safe.
- `wall-settings-business.client.ts`:
  - The Org chart section fetches `GET /api/admin/org` and renders
    `orgEditHtml(org, msg, pending)` open (not in `<details>`).
  - Remove the `biz-org` form, its submit branch, and the row "Remove"
    buttons that call `DELETE business/orgchart`. Removal goes through
    `remove-member`, which also drops the member's lines and refuses
    removing a project's PM.
  - Header: drop "Restart the daemon after a change here." Say: "Org chart
    changes apply at once. Projects, clients and schedules apply at the next
    start." (Check `reload` step 7 first: landscape rebuilds live too.)
- `/org` keeps its tree and uses the same module, so both pages show the
  same thing after any change.
- Keep `POST/DELETE /api/admin/business/orgchart` for the CLI and classic
  `/admin`; they are not shown on the Wall any more.

### 2. Move by picking, on each card

On each member row in `orgEditHtml`:

- **Reports to ▾**: a `<select>` of the other members plus "No one". A pick
  builds `add-relation reports-to` (or `remove-relation` for "No one") and
  goes through `orgConfirmFor`, which already turns "new boss" into
  remove-old + add-new with an undo list.
- **Add a line**: a small inline form (type: dotted line / acts for; target)
  replacing the global "Add relation" form. Lines the member already has are
  listed under the row with their own Remove.
- **Remove**: unchanged (`remove-member`, confirm first).

Each step is one `POST /api/admin/org/chart`; the refusal sentence from
`applyOrgEdit` is shown in the editor's status line.

### 3. Add agent here

- Each agent row gets **Add agent here**. It opens the existing Settings →
  Agents new-agent form with a read-only "Reports to: <name>" and a Role
  field.
- Server: `addAgent(body)` accepts optional `reportsTo` (an `agent:` /
  `person:` ref) and `role`. Inside the **same** `mutateAgentxConfig`
  callback, after writing `cfg.agents[id]`, run
  `applyOrgEdit(cfg, {op:"add-member", member:"agent:"+id, role})` and then
  `applyOrgEdit(cfg, {op:"add-relation", from:"agent:"+id, type:"reports-to", to})`.
  A refusal throws, so nothing is written: agent and line land together or
  not at all.
- `addAgent` is owner-gated today by the admin panel; keep it that way and
  check `opts.owner` for the org part too.
- A new agent still needs a restart to spawn (`detectAgentRestartFields`
  reports `add/remove`); the success line says so plainly.

### 4. No restart

Covered above: copy change plus a test that a `POST /api/admin/org/chart`
change reaches `business.org` through reload (extend the existing reload
test if there is one, otherwise `test/org-edit.test.ts`).

### Tests for (a)

- `test/org-edit.test.ts`: already covers refusals; add `addAgent` with
  `reportsTo` (happy path, cycle impossible for a new id, unknown boss →
  nothing written).
- A DOM-free test of the new per-row "Reports to" change → `orgConfirmFor`
  steps.
- Non-owner: `GET /api/admin/org` has `canEdit:false`, no `choices`; the
  Business tab shows the chart read-only; the route stays 403.

### Docs for (a)

- `docs/dashboard/settings.md` (Business section) and `docs/dashboard/org.md`:
  numbered steps for "change who someone reports to", "add a dotted line",
  "add an agent under someone", with screenshots from a demo instance under
  `docs/public/screenshots/settings/` and `.../org/`.
- Remove the restart note; end each page with **Check it worked** and **If
  something is wrong**. Run `pnpm docs:check`.

## PR (b): chat, point 5

### Tool `agentx_org`

`src/mcp/index.ts`, handler in a new `src/business/org-tool.ts` (same shape
as `src/approvals/tool.ts`):

- `action: "propose"` with `changes: OrgEdit[]` (one to five), optional
  `newAgent: {id, name, role, reportsTo}` and `why`.
- `action: "show"`: the current chart as plain lines, so the agent can map
  "CX" / "Sales" to member refs. Names are matched by the agent from this
  list; the tool never guesses ids.
- It never writes. It calls a new daemon route
  `POST /api/org/proposals`, which:
  1. Refuses unless the turn's source is the owner (same check the request
     store uses for owner turns; a cron, another agent or a contact gets "Only
     the owner can change the org chart.").
  2. Dry-runs every change with `applyOrgEdit` on a `structuredClone` of the
     config. Any refusal goes back to the agent as the plain sentence, and no
     card is made.
  3. Makes one Desk/Approvals card: text from `orgConfirmFor` ("cx-agent will
     report to sales-manager-agent, not … Apply?"), plus name, role and
     workspace when `newAgent` is set. `if_silent: "discard"`.
  4. Stores the proposal (changes + a hash of the config's `orgShape`) keyed
     by the card id.

### On yes

The daemon applies it, not the agent: when the card is approved, re-check
the `orgShape` hash. If the chart changed since the proposal, re-dry-run; on
a refusal mark the card failed with the sentence. Otherwise apply each
change through `mutateAgentxConfig(cfg => applyOrgEdit(cfg, change))` in one
callback (and `addAgent` for `newAgent`), so it is all or nothing. The
agent gets the usual decision message with the summary. This needs a small
hook in the approvals path: "on approve, run handler `org-proposal` with
the card id". That hook is the one new mechanism in this plan; check
`src/approvals/state.ts` before building it, in case one exists.

### Tests for (b)

- Non-owner source → refused, no card.
- Invalid change (cycle, self, unknown) → plain sentence, no card.
- Valid → one card; config unchanged until yes; after yes `GET
  /api/admin/org` shows the line.
- Chart changed between propose and yes → re-checked.

### Docs for (b)

`docs/reference/` MCP tool list entry for `agentx_org`, and a "Change the org
chart by chat" section on `docs/dashboard/org.md`.

## Acceptance criteria → where they land

| Criterion | PR |
|---|---|
| Business tab shows chart with visible Edit, no typed ids | (a) §1 |
| Pick a new manager, no restart, /org shows the same | (a) §1, §2, §4 |
| Dotted-line / acts-for add and remove in the same editor | (a) §2 |
| Add agent here → agent exists and reports to that member | (a) §3 |
| Chat request → one Desk card, nothing written before yes | (b) |
| Invalid changes refused in a plain sentence, UI and chat | (a) + (b), both via `applyOrgEdit` |
| Non-owners cannot edit (UI hidden, 403, tool refuses) | (a) + (b) |

## Open questions for Anis

1. Business tab: keep the `/org` tree above the editor there too, or the
   editor alone with a link to `/org`?
2. Should the Business tab's Remove still offer the old "remove the entry
   only" path, or is `remove-member` (drops the member's lines too) fine?
3. Chat proposals: Approvals card (exists today) or a new Desk card type?
   The plan uses the Approvals card.
