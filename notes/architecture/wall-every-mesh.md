# One Wall for every mesh (#1479)

> **Status:** design for the owner to shape. Nothing here is built.
> **Checked against:** `main` at `d1b774a` (2026-10-27).
> **What needs the owner's yes:** the four answers in [Decisions](#7-decisions-needed-from-the-owner).
> Outside access (a new way in for a person) is a change of direction, so
> slices 3 and 4 wait for that yes even if slice 1 goes ahead.

**Short answer:** the Wall already merges several machines into one view.
What it lacks is the idea of *a mesh*: today it reads one flat list of
machines, and that list is not even the same list `agentx mesh add`
fills. So step one is not a new system. It is to give the Wall one list of
meshes, each with its machines, and make every page read from it. Read-only
links to other people's meshes and outside people's roles come after, on
top of the scoped keys that already exist.

Words used here:

- **Machine** (a *node* in the code): one computer running the AgentX
  daemon.
- **Mesh**: machines that send work to each other and trust each other's
  keys. Today a node has one mesh: itself plus its `mesh.peers`.
- **Owner's mesh**: a mesh where you are the owner on every machine.
- **Linked mesh**: someone else's mesh (a client's, a supplier's) that lets
  your Wall see part of it.

## 1. What exists today

Three different lists name "the other machines", and each surface reads a
different one:

| List | Where it lives | Filled by | Read by |
|---|---|---|---|
| `mesh.peers` | `agentx.json` | `agentx mesh add`, mesh invite links | The daemon: tasks between machines (`src/a2a/mesh.ts`), mesh auth (`src/daemon/mesh-auth.ts`) |
| `dashboard.daemons` | `agentx.json` | By hand in the config (not by `agentx mesh add`) | The Wall's posts and weekly throughput (`buildWallFleet`, `buildWallThroughputFleet` in `src/daemon/board-dashboard.ts`), the topbar machine picker, the admin proxy |
| Guest hosts | `.agentx/guest-hosts.json` (owner-only file, not in `agentx.json`) | `agentx mesh join` | `POST /mesh/task` to a host's guest route, `agentx mesh ask`, `agentx mesh hosts` (`src/guests/hosts.ts`) |

On top of that, `resolveNodeTargets` (`board-dashboard.ts`) builds a fourth
answer for the Live snapshot, Running now, analytics and the phone app's
Fleet and Desk: the primary, plus `dashboard.daemons`, plus whatever the
primary's `/mesh` reports.

**What this means in practice:** a peer added with `agentx mesh add` shows
under **Running now** and on the phone's **Fleet** tab, but its posts, its
failures and its throughput do **not** show on the Wall until someone also
adds it to `dashboard.daemons`. A machine joined as a guest shows nowhere on
the Wall.

What the Wall already does well, and the design keeps:

- **Fan-out with partial failure.** `?peer=fleet` asks every machine at
  once, waits at most 8 s per machine, and lists one that does not answer as
  unreachable while the rest still show (#1180, #1252).
- **Provenance.** Every merged post, failure and report carries
  `node: { name, peer, daemonUrl }`.
- **Writes go home.** A comment or a call on a post is proxied to the
  machine that keeps it, with that machine's own token
  (`src/daemon/wall-actions.ts`, `proxyAdminToPeer`). The owner-only guard
  (#1454) runs first.
- **Scoped keys.** `agentx token create --scope` already supports
  `dashboard:read`, `dashboard:write`, `agent:<id>`, `mesh:peer`, `app`,
  `wall:portfolio`, `member:<name>` and `guest:<grant>`
  (`src/daemon/token-store.ts`). `wall:portfolio` (#1194) is the precedent
  for "one key per named person, opens one read-only view and nothing
  else".
- **No widening.** `dashboard.token` is deliberately not accepted on mesh
  write paths (`collectAcceptedMeshTokens`).

Wall pages that read **this machine only** today: Cost
(`/api/admin/observability/cost`), budgets, Reviews, workflow runs, Org, and
the Activity page's monitor view. Each needs its own merge rule before it can
say "the whole company".

## 2. The model

```
Wall (on any machine)
 └─ Mesh            "Studio" (owner's)  ·  "Client A" (linked, read-only)
     └─ Machine     studio-mac, studio-server  ·  client-a-server
         └─ Agent, post, run, decision card, cost line
```

1. **One list: `wall.meshes`.** Each entry names a mesh, its kind (`owner`
   or `linked`) and its machines. The owner's own mesh is built
   automatically from `mesh.peers` + `dashboard.daemons` + `/mesh`
   discovery, the same set `resolveNodeTargets` uses, so the Wall and
   Running now finally agree. Linked meshes are added explicitly
   (slice 3).
2. **Every item is labelled `mesh · machine`.** The existing `node` tag gains
   a `mesh` field. An item's id on the Wall becomes `<mesh>/<machine>/<id>`
   so two meshes can reuse an agent name or request id without clashing.
3. **Actions go to the owner of the item, with the owner's key.** The Wall
   never acts on a remote mesh with a credential that mesh did not mint for
   it. On a linked mesh, the key is read-only unless that mesh's owner gives
   more, so the Wall hides the buttons rather than greying them.
4. **The remote side filters; the Wall only narrows.** A linked mesh answers
   with what its key allows. The Wall can hide more, never show more. This
   is what keeps "no mesh trusts another more than today" true even if the
   Wall machine is compromised.
5. **Offline is a state, not an error.** Per mesh and per machine:
   *online*, *slow* (answered after 8 s, shown next time), *offline since
   <time>*, *key refused*. The Wall keeps the last good answer for one
   refresh cycle, greyed with its age, then drops it. It never stores a
   linked mesh's content on disk.

## 3. Proposed answers to the open questions

**Q1. Where it runs.** Any machine can show the whole company, because the
fan-out already runs in whichever dashboard you open. One machine is marked
**home**: it is the one outside people sign in to (#1478) and the one that
holds linked-mesh keys. Other machines of the owner's mesh show linked
meshes by asking home, so the keys live in one place.
*Default if the owner says nothing: the machine where `dashboard.token` is
set and the Wall is opened most is home; `agentx wall home` changes it.*

**Q2. Adding a mesh.** Two kinds, not one:

| | Owner's mesh peer | Linked mesh (new) |
|---|---|---|
| Added with | `agentx mesh add` / invite link (today) | `agentx mesh link <invite>` (new), made by the other mesh's owner |
| Trust | Full: tasks, writes, settings | Read-only by default; the other owner can add `wall:write` for chosen agents |
| Key | Mesh token, both ways | One scoped key, one way, with an end date, revocable on their side |
| Shows on their side | As a peer | Under **Who can see this mesh**, with last access |

The linked mesh reuses the token store with one new scope,
`wall:read`, plus an optional filter (`agent:<id>`, project). No new
protocol: the Wall calls the same `GET /api/admin/wall` it already calls on
peers, and the remote side applies the filter.

**Q3. Outside people.** A person gets a role **per mesh**, granted on the
home Wall: *viewer* (posts and results), *requester* (can open a post for
chosen agents), or *owner*. The grant can name agents or projects inside the
mesh, so a supplier sees only the agents that work with them. Nobody sees a
mesh they were not granted. Everything an outside person can see is already
redacted (`redactSecrets`) and bounded, as Wall posts are today. This is the
same shape #1478 needs, so it is decided once there and reused here.

**Q4. Order.** Slice 1 below fixes a real gap (peers missing from the Wall)
and needs nothing from #1478, so it can go right after the #1449 pages it
touches. Slices 3 and 4 wait for #1478's identity model, because outside
access must be granted once, not twice.

## 4. Slices

| # | Slice | Size | Depends on | Change of direction? |
|---|---|---|---|---|
| 1 | **One list of machines.** The Wall's posts and throughput read the same set as `resolveNodeTargets`, so `agentx mesh add` peers show on the Wall. Items gain `mesh`, the header shows one line per mesh with its online count. | S | none | No: it finishes what ships |
| 2 | **Merge the local-only pages.** Cost, budgets, Reviews, workflow runs and Org fan out with the same partial-failure rule, each with a stated merge rule (cost adds up per mesh, never across currencies; reviews keep their machine). Retire `/mesh` (#1446) once Activity (#1429) covers its last job. | M | #1449 pages | No |
| 3 | **Linked meshes, read-only.** `wall:read` scope, `agentx mesh link`, a **Meshes** section in Settings, keys stored like guest hosts (owner-only file, not `agentx.json`), remote-side filtering, revocation shown on both sides. | M | Owner's yes on Q2 | **Yes** |
| 4 | **People and roles across meshes.** Roles per person per mesh on the home Wall, built on #1478 sign-in. | M–L | #1478, slice 3 | **Yes** |
| 5 | **Writes on linked meshes.** Answer a card or comment on a post in a linked mesh when its owner granted `wall:write` for that agent. | S | slice 3 | Yes, per grant |

Each slice updates `docs/dashboard/wall.md` (and adds a page for linked
meshes in slice 3) in the same PR, as the docs rule asks.

## 5. Risks

- **Cost of the fan-out.** N meshes × M machines on every refresh. Peers are
  already asked in parallel with an 8 s cap; linked meshes should refresh
  less often (60 s) than the owner's own.
- **Secrets in `agentx.json`.** `dashboard.daemons[].token` lives in the
  config file today. Linked-mesh keys must not: store them like guest hosts.
- **Sensitive content leaving a mesh.** The list reply must stay a bounded
  summary (`TEXT_MAX`, redaction) for linked meshes; full threads open only
  on demand and only with the right scope.
- **Name clashes.** Two meshes can both have `dev-agent` and a machine named
  `server`. The `<mesh>/<machine>/<id>` id and the visible `mesh · machine`
  label cover it; the existing code already keys peers by address, not name.
- **Two "fleet" definitions drifting again.** Slice 1 should make
  `resolveNodeTargets` the single source and have the Wall call it, with a
  test that a `mesh.peers`-only peer appears in `?peer=fleet`.

## 6. Check it worked (for slice 1)

1. On the demo (`pnpm docs:demo`), remove the peers from
   `dashboard.daemons`, keeping them in `mesh.peers`.
2. Open the Wall. Every peer's posts still show, each labelled with its
   mesh and machine.
3. Stop one peer. The Wall shows it as offline and keeps the others.

## 7. Decisions needed from the owner

- **D1. Home machine.** Any machine shows everything, one is *home* for
  outside access and linked keys. Agree?
- **D2. Two kinds of link.** Keep today's peers as they are, add a lighter
  read-only *linked mesh* made by the other side. Agree?
- **D3. Roles.** Viewer, requester, owner, per person and per mesh, narrowed
  by agent or project. Is that enough for clients, providers and suppliers?
- **D4. Order.** Slice 1 now (no change of direction), slices 3–4 after
  #1478's identity model. Agree?

## If something is wrong

If the code has moved since `d1b774a`, re-check the three lists in
[section 1](#1-what-exists-today): the gap this design starts from is that
`agentx mesh add` (in `src/commands/manage.ts`) and the Wall's fan-out (in
`buildWallFleet`) read different lists. If that is already fixed, slice 1 is
done and the next step is slice 2.
