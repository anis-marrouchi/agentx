# Team

Path: `/admin` → **Team** tab

Where you tell agentx about the *humans* who fill in workflow forms. If a workflow has a "review this grant application" step that needs a person (not an agent) to approve, this is the page that says who that person is and where to ping them.

Two sections: **Actors** (individual humans) and **Roles** (named groups of actors). Together they answer "this workflow user-task needs human attention — who, on what channel, and how do we pick when there's more than one?".

> **Important distinction.** The Actors here are *workflow* actors — people who receive user-task forms. They are **not** the same thing as the business roles in the [Business tab](./business), which describe org-chart positions ("engineer," "PM," "support"). Business roles describe org structure; workflow actors receive forms. Different tables, different purposes. A single human is usually represented in both — once as a business org-chart row, once as a workflow actor — and that's normal.

## What you'll see

Two sections stacked vertically:

- **Actors** — one row per human. Each actor has an `id` that starts with `actor:` (e.g. `actor:alice`, `actor:bob.smith`), a display name, and one or more channel handles. Each handle pairs a channel kind (`telegram`, `whatsapp`, `slack`, `discord`, `email`) with the platform-specific identifier (Telegram `chatId`, WhatsApp number, Slack `@username`, Discord user id, email address). One handle per actor can be flagged "preferred for tasks" — shown in the table with an asterisk. When a user-task notification fires, the preferred channel is tried first; the others are fallbacks.
- **Roles** — one row per role. Each role has an `id` that starts with `role:` (e.g. `role:reviewers`, `role:on-call`), a list of members (which can be other actors *or* other roles — roles can nest), and an `assignmentStrategy`:
  - `first-available` (default) — the first member who hasn't acked another task gets it.
  - `round-robin` — rotate through members in order; agentx remembers the last one assigned.
  - `all` — notify every member; first to submit wins, the others' notifications stay informational.

Every row has Edit and Delete. Add via the **+** button at the top of each section. The role-edit form shows a live preview of the resolved actor list, so you can see exactly who would be notified after nesting and de-duplication.

## What you can do

- Add a new human reviewer with their channel handles, mark a preferred channel.
- Create a role and grant membership to existing actors or other roles.
- Revoke an actor from a role without deleting the actor.
- Switch a role's assignment strategy (e.g. start with `first-available`, switch to `round-robin` once you have a real team).
- See exactly who would be notified for a given role, including nested-role expansion (the UI shows the resolved actor list at the bottom of each role row).
- Send a test notification to an actor to confirm the channel handle actually works before relying on it for a real workflow.

Saves apply immediately — Team config is hot-reloaded, no daemon restart needed. This is unlike the [Business tab](./business), which requires an explicit reload. Changes here take effect the next time a workflow assigns a task.

## Common tasks

1. **"Add a new reviewer who'll receive grant-application forms on WhatsApp."**
   Actors → **+** → `id` = `actor:carol`, name = "Carol", add a `whatsapp` handle with her number, mark it preferred-for-tasks. Save. Then add `actor:carol` to whichever role the workflow's `userTask.assignTo` points at (probably `role:grant-reviewers`).

2. **"Create a 'compliance' role with three actors that round-robin."**
   Roles → **+** → `id` = `role:compliance`, members = `actor:alice`, `actor:bob`, `actor:carol`, strategy = `round-robin`. Save. The first compliance task goes to alice, the next to bob, the next to carol, then wraps. The rotation pointer is persisted across daemon restarts.

3. **"Add the new hire to the existing 'on-call' role."**
   Roles → edit `role:on-call` → click **+ member** → pick `actor:dave` from the dropdown. Save. Done — no need to touch the rest of the row.

4. **"Switch a single-person role into a real team."**
   The role currently has one member and `first-available`. Add two more members, switch strategy to `round-robin`. Save. New tasks rotate immediately.

5. **"Test that notifications actually reach an actor."**
   Click an actor row → **Send test notification**. The dashboard fires a one-time message to the preferred channel. If it doesn't arrive, the channel handle is wrong (typo in chat id, expired Slack token, etc.) — fix it before the actor receives a real task.

6. **"Retire an actor who left the team."**
   Actors → delete the row. They're automatically revoked from every role. Any in-flight tasks already assigned to them stay assigned — reassign manually from the [Inbox](./inbox).

7. **"Build an escalation chain."**
   Roles can nest. Create `role:l1-support` with three actors, then create `role:escalations` with members `role:l1-support` plus `actor:senior-engineer`. A workflow can assign the first task to `role:l1-support`; if it times out, the SLA-escalation transition reassigns to `role:escalations` (which is the same three people *plus* the senior engineer).

8. **"Quietly take someone off-rotation for a week."**
   Don't delete the actor — that loses their handles and history. Instead, revoke them from the relevant roles (Roles section → edit role → remove member). Re-grant when they're back.

## Troubleshooting

- **"The inbox is empty even though I assigned a task to a role."** Open the role and check member count. A role with zero members assigns to nobody — the task is created but unassigned. Round-robin and first-available both silently no-op when the member list is empty. Add at least one actor.
- **"An actor isn't getting notifications."** Open the actor row and look at their handles. If the preferred-for-tasks asterisk is on a channel that isn't actually configured (e.g. preferred = `slack` but Slack isn't in [Channels](./admin)), the notification falls back to the next handle. Either configure the channel or change the preferred handle.
- **"Round-robin keeps picking the same person."** It only advances when the previously-assigned task is acked. If the previous round-robin assignee hasn't responded, the rotation pointer doesn't move. Long story short: ack old tasks (or auto-expire them via the workflow's SLA) and rotation resumes.
- **"I added a nested role and now I see duplicate notifications."** Role A contains role B *and* contains some of role B's actors directly. The resolver de-duplicates by actor id, but if the strategy is `all`, every distinct member is still notified once. If you want fewer notifications, restructure: nest *or* list directly, not both.
- **"Test notification button does nothing."** The actor has no preferred-for-tasks handle and no fallback handles either. Add at least one handle.
- **"Two actors with the same name."** Display names don't have to be unique; ids do. If you need to disambiguate visually, suffix the display name (e.g. "Alice (Compliance)" vs "Alice (Engineering)") — the id stays clean.
- **"I deleted a role that a workflow still references."** The workflow definition still names the role; assignments will fail until you either re-create the role or update the workflow's `userTask.assignTo`. Check [Workflows](./workflows) for which workflow is broken.

## Picking an assignment strategy

Three strategies, three different operational shapes:

- **`first-available`** — best when "anyone qualified can do this." Cheapest in notification volume; the first-available actor gets pinged, no one else hears about it unless they time out.
- **`round-robin`** — best when fairness matters more than speed. Compliance reviews, code reviews on shared rotations, support tickets that should be evenly distributed. Notice that fairness depends on tasks being acked promptly; if one member ghosts, the rotation pointer stalls on them.
- **`all`** — best for high-urgency or quorum decisions ("any senior can sign off, but they should all see it"). Most expensive in notification volume — every member gets pinged on every task — so reserve it for things that genuinely warrant the noise.

You can change strategies any time; in-flight tasks already assigned keep their assignee.

## CLI parity

- `agentx actor add | list | show | remove` — manage the Actors table.
- `agentx role create | list | grant | revoke` — manage the Roles table. `grant` adds a member, `revoke` removes one.

The CLI and dashboard write to the same store, so you can mix freely — add an actor on the terminal, drop them into a role from the browser. Both surfaces are hot-reloaded; no daemon restart needed.
