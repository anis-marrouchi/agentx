# Wall sign-in with Google or an email link, round 1 (#1478)

Design proposal for review. Nothing here is built. Per #1478, nothing gets built until the owner answers the [questions](#questions-for-the-owner) and accepts a design, the same design-first rule as #1449. Comment on #1478.

This round covers how the sign-in works: who may sign in, how each method proves who someone is, what a signed-in person may open, and what is reused. The screens (sign-in page, "check your mail" page, the People page changes, the approval card) come in round 2, once the questions are answered, because the answers change what goes on them.

All names and addresses below are made up: people Dana (member) and Lee (client), `example.com`, the machine `studio`.

## In one paragraph

Signing in proves **who** a person is. The [people list](../../docs/jobs/people.md) still decides **whether** they get in and **what role** they have. The owner adds an email address to a person (`agentx people link dana email:dana@example.com`). After that, Dana can sign in either with the Google account for that address or with a link sent to it. Anyone not on the list gets nothing, and is not told whether the address is known. A sign-in gives the browser a personal session tied to Dana's person id. The owner sees it on Dana's page under their machines, and **End access** ends it, as it does for a paired machine today. The Wall shows each role its own part. Only the owner can write or change settings; #1454 stays as it is.

## What exists today, and what it means for this design

Checked on main (`c2d2c55`).

| What | Where | What it means here |
|---|---|---|
| People list: `id`, `name`, `role` (owner / member / client / guest), `identities: ["channel:id"]` | `src/people/people.ts:30`, schema `src/daemon/config.ts:1700` | No email or Google field exists yet. An `email:…` identity already passes the schema and the duplicate check (`peopleProblem`, `people.ts:84`), so **no new field is needed**. `currentPeople()` reads the list again on each request, so removing a person takes effect at once. |
| Dashboard sign-in: `/login` with `dashboard.token`, cookie `ax_session` (30 days) | `src/daemon/dashboard-session.ts` | The cookie is an HMAC of the token, the same value for everyone. It carries **no person**, and every gate that accepts it (`adminTokenOk`, `board-dashboard.ts:3240`) treats it as full owner access. It cannot be reused as is for a member or a client (see [Decision 1](#1-a-personal-session-not-the-token-cookie)). |
| Member and client access: pairing code, approval card, a key per machine (90 days), cookie `agentx_member` | `src/members/pairing.ts`, `src/daemon/member-routes.ts` | This is the pattern to copy: a credential that names one person, a card for a new machine, the device list and **End access** on People (`people-panel.ts:138`). Members see `/member` (My work) and clients see Your project, never the Wall. |
| Wall owner-only writes (#1454) | `wallOwnerOk`, `board-dashboard.ts:3252`; `isWallWrite`, `wall-actions.ts:78` | Writes stay owner only. Today there is **no read-only viewer**: with a token set, Wall reads need the token too; without one, anyone who reaches the address reads. Each role's view is new work. |
| Publishing on the network: `tailscale serve` of `/member` and `/app` paths only | `docs/jobs/members.md`, `src/commands/app.ts:243` | The dashboard trusts what reaches it from its own computer, so the whole dashboard must never be published. Sign-in needs its own small set of published paths, as the member page has. |
| Sending mail: SMTP through nodemailer | `src/channels/email/smtp.ts:43`, accounts under `channels.email.accounts` | Every mail account belongs to an agent. There is no "system" sender yet ([question 3](#questions-for-the-owner)). |
| Google / OAuth sign-in | none in `src/` | New code. It needs no new library: the flow is a few HTTPS calls and checks (see [Decision 3](#3-google-sign-in)). |

## The flow

```
Person's browser            The Wall (home machine)                 Google / mail
────────────────            ───────────────────────                 ─────────────
open the Wall ───────────▶  no session → sign-in page
"Sign in with Google" ───▶  make state + nonce + PKCE ───────────▶  Google sign-in
                            ◀─────────── code (back to /signin/google/done)
                            exchange code, check the token
   or
type an email address ───▶  same answer whether known or not;
                            if the address is on the people list ─▶  mail with a link
open the link, press
"Sign in" ───────────────▶  check and spend the one-time link

                  then, for both:
                            find the person by the address
                            not on the list → "No access"
                            first sign-in → approval card (question 4)
                            personal session cookie, person id inside
                            open the Wall part for that role
```

## Decisions proposed

### 1. A personal session, not the token cookie

The issue says to reuse `ax_session`. The proposal keeps everything around it (the `/login` address, the 30-day length, the sign-in page look, `HttpOnly` and `Secure`) but **not the cookie itself**:

- Today, a valid `ax_session` means "owner" to five gates in `board-dashboard.ts` (counted on `c2d2c55`). If a member's session had the same name, one missed check would let a member change settings. The gates are:
  1. The Wall write guard: `wallOwnerOk` at line 270, before any route runs.
  2. The peer proxy for another machine's API: `adminTokenOk` at line 663.
  3. The admin API: `adminTokenOk` at line 790, which also issues stream tickets.
  4. The general `/api/*` check: its own `hasSession` call at line 1232, which `/api/workflows` relies on.
  5. Pages opened from another machine: `pageAllowed` at line 3269, used by 12 pages.

  Only two places read the cookie: `adminTokenOk` (line 3244) and the `/api/*` check (line 1232). Stream tickets (`streamTicketOk`) are signed with the token, not the cookie, so they are not a sixth gate. Slice 1 counts these again and lists them in its PR.
- A personal session is a random value. The Wall keeps only its hash, in `.agentx/wall-sessions.json`, with the person id, when it started, when it was last used, and a short label for the browser ("Chrome on a Mac"). The same as `.agentx/tokens.json` does for member keys.
- Its cookie is `ax_person`. The gates then ask one question: "which person is this?" A token session or a local caller answers "the owner", as today. A personal session answers with its person and role.
- An owner who signs in with Google or a link gets the owner role, so the same rights as the token today ([question 5](#questions-for-the-owner)).
- Changing `dashboard.token` still signs out token sessions only. Removing a person from the list, or **End access**, ends that person's sessions at their next request.

### 2. Who may sign in

- A person can sign in only when their people entry has an `email:` identity, for example `email:dana@example.com`. One line covers both methods.
- Addresses are compared in lower case, exactly, with no `+tag` or dot rules. Two people cannot share an address (the existing duplicate check).
- After the first Google sign-in, the Wall adds `google:<account id>` to the person. From then on, Google sign-in matches that id, so a person who changes the address on their Google account still gets in, and a new account that takes over an old address does not.
- Guests (`role: guest`) do not sign in. They reach agents through channels only, as today.

### 3. Google sign-in

- Standard "Sign in with Google" (OpenID Connect, code flow with PKCE, `state` and `nonce`). It asks only for `openid email profile`: Google tells the Wall the address and the name, and nothing else (no mail, no Drive).
- Google's answer is taken only if the address is marked **verified**. If the owner sets `hd` (a Google Workspace domain), only accounts of that domain are accepted.
- The secret code exchange happens from the Wall to Google directly, over HTTPS, so the browser never holds the Google tokens. The Wall keeps nothing from Google beyond the account id and the address. It does not keep Google's tokens at all.
- **Setup for the owner** (once): make an OAuth client in the Google Cloud console, of type "Web application", with the return address `https://<the Wall's address>/signin/google/done`. Then put the client id in `agentx.json` and the secret in `.env`.
- **A public address is not needed for Google.** Google sends the person's browser back to the return address; Google itself never calls the Wall. So a fixed HTTPS name that the person can reach is enough, for example the machine's Tailscale name `https://studio.example-tailnet.ts.net`. What matters is that the person's browser can open it ([question 1](#questions-for-the-owner)).

### 4. Sign-in with an email link

- The person types their address. The page always says "If this address may sign in, a link is on its way", whether the address is known or not. Nobody can use the form to find out who is on the list.
- The link holds a one-time code. It lasts 15 minutes, works once, and only the hash is kept (as with the member pairing codes in `.agentx/pair-codes.json`). Asking again replaces the earlier link.
- The link opens a page with a **Sign in** button; pressing it signs in. Mail apps and company filters often open links on their own to check them; with the button, that check does not use up the link.
- Limits per address and per network address (for example 5 links an hour per address) stop the form being used to flood someone's inbox.
- The mail goes out through an SMTP account the owner picks ([question 3](#questions-for-the-owner)). It is plain and short: who it is from, the link, how long it works, and "you can ignore this if it was not you".

### 5. What each role sees

There is no read-only Wall today, so this is the largest new piece. The proposal, until the owner says otherwise ([question 2](#questions-for-the-owner)):

| Role | After sign-in |
|---|---|
| owner | The whole Wall, as on this machine today, writes and settings included. |
| member | The Wall read only, as drawn in round 2 of Wall v2 for "anyone else" (#1451): the feed, Needs the owner without buttons, Running now, Projects, Activity, Agents, People, Org. Plus **My work**. No Settings, no Cost. |
| client | **Your project** only, as today. No Wall until #1479 decides who sees which mesh. |
| guest | Cannot sign in. |

- Each Wall read checks the role on the server. Hiding a nav item is not the guard.
- Writes keep the #1454 guard. A member's session never passes `wallOwnerOk`.
- A signed-in member or client also reaches `/member` without pairing a machine. Pairing stays for those who prefer it, and for the phone app.

### 6. Publishing the Wall for signed-in people

The whole dashboard must never be published (see `docs/jobs/members.md`). So the proposal is a small, fixed set of published paths, like the member page has:

- `/signin` (the page and the Google return address) and `/api/signin`;
- `/w` (the Wall for signed-in people) and `/api/w` (its reads, which accept **only** a personal session, never "local caller" or the token).

A request on these paths without a personal session gets the sign-in page, never the owner's view, even when it reaches the dashboard from its own computer through `tailscale serve`. `agentx people invite` and `agentx app` already check for over-published paths; the same check covers these.

### 7. The first sign-in

- The proposal: a person's **first** sign-in raises an approval card ("Dana signed in for the first time, with Google, from Chrome on a Mac. Let them in?"), the same card as a new member machine (`createCard`, `members/pairing.ts:225`). Until the owner says yes, Dana sees "Waiting for the owner", as a new member machine does.
- Later sign-ins of the same person, from any browser, go straight in, and appear on their People page.
- A setting lets the owner skip the card for members ([question 4](#questions-for-the-owner)). For clients, the card stays.

### 8. One identity for every mesh (#1479)

#1479 makes this sign-in the people layer across meshes: outside people are let in once, on the Wall. This design keeps that open:

- The person signs in on one machine only, the Wall's home machine. Sessions, links and the Google setup live there.
- When the Wall reads or acts on another mesh, it uses that mesh's own key, as #1479 says ("no mesh trusts another more than it does today"). The person id travels with the request so the other mesh can record who asked, but it is not a credential there.
- A role per mesh (for example a supplier who sees only one mesh) is a later field on the person (`meshes`). It belongs to the #1479 design, not to this one.

### 9. What is logged

Every sign-in, refused sign-in (unknown address, unverified Google address, used or old link), first-sign-in card, sign-out and **End access** goes to `.agentx/members-log.jsonl`, next to the member events. The log holds the person id and the method, never the link code or anything from Google beyond the account id.

## Settings this would add

None of these exist yet. Each one gets a docs page or section in the same change that adds it (CLAUDE.md, Documentation Rule).

| Setting | Where | Meaning |
|---|---|---|
| `wall.signIn.origin` | `agentx.json` | The fixed HTTPS address of the Wall, used for the Google return address and the links in mails. |
| `wall.signIn.google.clientId` | `agentx.json` | The Google OAuth client id. Unset: no Google button. |
| `AGENTX_GOOGLE_CLIENT_SECRET` | `.env` | The client secret. |
| `wall.signIn.google.hd` | `agentx.json` | Optional. Only Google accounts of this Workspace domain. |
| `wall.signIn.email.account` | `agentx.json` | Which `channels.email.accounts` entry sends the links. Unset: no email form. |
| `wall.signIn.firstSignIn` | `agentx.json` | `card` (default) or `auto` for members. |
| `agentx people link <id> email:<address>` | CLI, exists | How the owner lets a person sign in. No new command. |

## How it would be built, once accepted

Small slices, each one usable and tested on its own:

1. Personal sessions: the store, the `ax_person` cookie, "which person is this?" in the gates, sessions on the People page with **End access**. Covered by tests that a member session is refused by every owner gate in the [Decision 1](#1-a-personal-session-not-the-token-cookie) list, counted again when the slice is built.
2. Email link sign-in, with the published `/signin` paths.
3. Google sign-in.
4. The read-only Wall for members on `/w` (uses the round 2 "anyone else" designs from #1451).
5. The first-sign-in card.

## Questions for the owner

1. **Network.** Does the Wall stay on the private network, with sign-in on top (people outside reach it through a Tailscale share, as members do today)? Or does it get a public address? Google sign-in works with both: it needs a fixed HTTPS name the person's browser can reach, not a public one. A public address would let clients and suppliers in without Tailscale, but puts the sign-in page on the open internet. *Proposal: private network first; a public address later, as its own decision.*
2. **Roles on the Wall.** Is the member view in [Decision 5](#5-what-each-role-sees) right? Should a client see anything of the Wall now, or wait for #1479?
3. **Email sender.** Which account sends the links: an existing `channels.email` account (an agent's mailbox), or a new address used only for this (for example `no-reply@` on the company domain)? *Proposal: a dedicated address, set up as an email account with no agent replying from it.*
4. **First sign-in.** Always an approval card, or automatic for anyone on the people list? *Proposal: a card for the first sign-in of each person; members can be set to automatic.*
5. **The owner signing in with Google.** Should the owner's Google account give full owner rights from any browser, as the dashboard token does today? Or should owner rights stay with the token and this machine, and a Google sign-in as the owner give the member view? *Proposal: full owner rights, with the first owner sign-in confirmed on this machine.*
6. **Cookie.** [Decision 1](#1-a-personal-session-not-the-token-cookie) uses a new cookie (`ax_person`) instead of reusing `ax_session`, so a member session can never be mistaken for the owner. Is that change from the issue fine?

## Not proposed

- **Email and password**, as the issue says: it needs password storage, reset and lockout flows, and a link does the same job with less to protect.
- Other sign-in providers (Microsoft, GitHub, Apple). The Google part is plain OpenID Connect, so another provider would be a settings change later, not a redesign.
- Letting people add themselves. The owner still adds each person to the list.
