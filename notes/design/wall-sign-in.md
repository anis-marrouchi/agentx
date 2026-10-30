# Wall sign-in with an email link, Google if available, round 1 (#1478)

Design proposal for review. Nothing here is built. Per #1478, building starts once the AgentX issue list is clear, not before, and only on an accepted design (the same design-first rule as #1449). Comment on #1478.

**Revised 2026-10-30** after the owner's scope on #1478 (the second answer, about 19:30Z):

- A link sent by email is the way to sign in (no password). It ships in any case.
- The links go out through the owner's mail provider (Mailgun), set up as a configured provider.
- **Sign in with Google is on standby.** It is in scope only once we have access to the owner's Google Cloud account and a project we can use there. The access check on #1478 (2026-10-30) found none: the saved logins have expired and no OAuth client exists. So the email link ships alone, and Google waits ([Decision 5](#5-sign-in-with-google-on-standby)).
- Keys come only from `agentx.json` or `.env`, never from the repo, the issue or a chat. No code is written for one provider only, and nothing billable is created in Google Cloud without asking first.

This round covers how the sign-in works: who may sign in, how the link proves who someone is, how the mail is sent, what a signed-in person may open, and what is reused. The screens (sign-in page, "check your mail" page, the People page changes, the approval card) come in round 2, once the questions are answered, because the answers change what goes on them.

All names and addresses below are made up: people Dana (member) and Lee (client), `example.com`, the machine `studio`.

## In one paragraph

Signing in proves **who** a person is. The [people list](../../docs/jobs/people.md) still decides **whether** they get in and **what role** they have. The owner adds an email address to a person (`agentx people link dana email:dana@example.com`). After that, Dana can type that address on the sign-in page and get a short-lived, single-use link by mail. Anyone not on the list gets nothing, and is not told whether the address is known. A sign-in gives the browser a personal session tied to Dana's person id. The owner sees it on Dana's page under their machines, and **End access** ends it, as it does for a paired machine today. The Wall shows each role its own part. Only the owner can write or change settings; #1454 stays as it is.

## What exists today, and what it means for this design

Checked on main (`033b25c`).

| What | Where | What it means here |
|---|---|---|
| People list: `id`, `name`, `role` (owner / member / client / guest), `identities: ["channel:id"]` | `src/people/people.ts`, schema in `src/daemon/config.ts` | No email field exists yet. An `email:…` identity already passes the schema and the duplicate check (`peopleProblem`), so **no new field is needed**. `currentPeople()` reads the list again on each request, so removing a person takes effect at once. |
| Dashboard sign-in: `/login` with `dashboard.token`, cookie `ax_session` (30 days) | `src/daemon/dashboard-session.ts` | The cookie is an HMAC of the token, the same value for everyone. It carries **no person**, and every gate that accepts it (`adminTokenOk` in `board-dashboard.ts`) treats it as full owner access. It cannot be reused as is for a member or a client (see [Decision 1](#1-a-personal-session-not-the-token-cookie)). |
| Member and client access: pairing code, approval card, a key per machine (90 days), cookie `agentx_member` | `src/members/pairing.ts`, `src/daemon/member-routes.ts` | This is the pattern to copy: a credential that names one person, a card for a new machine, the device list and **End access** on People (`people-panel.ts`). Members see `/member` (My work) and clients see Your project, never the Wall. |
| Wall owner-only writes (#1454) | `wallOwnerOk` in `board-dashboard.ts`; `isWallWrite` in `wall-actions.ts` | Writes stay owner only. Today there is **no read-only viewer**: with a token set, Wall reads need the token too; without one, anyone who reaches the address reads. Each role's view is new work. |
| Publishing on the network: `tailscale serve` of `/member` and `/app` paths only | `docs/jobs/members.md`, `src/commands/app.ts` | The dashboard trusts what reaches it from its own computer, so the whole dashboard must never be published. Sign-in needs its own small set of published paths, as the member page has. |
| Sending mail: SMTP through nodemailer, `${VAR}` values read from `.env` | `src/channels/email/smtp.ts` (`sendMail`, `mailServers`), accounts under `channels.email.accounts` | Every mail account belongs to an agent and needs an IMAP inbox (`emailAccountSchema`). There is no "system" sender. The SMTP sending code itself is generic and can be shared (see [Decision 4](#4-the-mail-provider)). |
| Secrets in config | `loadDotEnv` and `*Env` fields in `src/daemon/config.ts` | Secrets stay in `.env`; `agentx.json` holds only the name of the variable or a `${VAR}` reference. The mail provider follows the same rule. |

## The flow

```
Person's browser            The Wall (home machine)              Mail provider
────────────────            ───────────────────────              ─────────────
open the Wall ───────────▶  no session → sign-in page
type an email address ───▶  same answer whether known or not;
                            if the address is on the people list ─▶  mail with a link
                                                                     ─▶ person's inbox
open the link, press
"Sign in" ───────────────▶  check and spend the one-time link
                            find the person by the address
                            not on the list (any more) → "No access"
                            first sign-in → approval card (question 3)
                            personal session cookie, person id inside
                            open the Wall part for that role
```

## Decisions proposed

### 1. A personal session, not the token cookie

The issue says to reuse `ax_session`. The proposal keeps everything around it (the `/login` address, the 30-day length, the sign-in page look, `HttpOnly` and `Secure`) but **not the cookie itself**:

- Today, a valid `ax_session` means "owner" to several gates in `board-dashboard.ts`. If a member's session had the same name, one missed check would let a member change settings. The gates counted for the first version of this note were:
  1. The Wall write guard: `wallOwnerOk`, before any route runs.
  2. The peer proxy for another machine's API: `adminTokenOk`.
  3. The admin API: `adminTokenOk`, which also issues stream tickets.
  4. The general `/api/*` check: its own `hasSession` call, which `/api/workflows` relies on.
  5. Pages opened from another machine: `pageAllowed`, used by 12 pages.

  Stream tickets (`streamTicketOk`) are signed with the token, not the cookie, so they are not a sixth gate. Slice 1 counts these again on the main of that day and lists them in its PR.
- A personal session is a random value. The Wall keeps only its hash, in `.agentx/wall-sessions.json`, with the person id, when it started, when it was last used, and a short label for the browser ("Chrome on a Mac"). The same as `.agentx/tokens.json` does for member keys.
- Its cookie is `ax_person`. The gates then ask one question: "which person is this?" A token session or a local caller answers "the owner", as today. A personal session answers with its person and role.
- Changing `dashboard.token` still signs out token sessions only. Removing a person from the list, or **End access**, ends that person's sessions at their next request.

### 2. Who may sign in

- A person can sign in only when their people entry has an `email:` identity, for example `email:dana@example.com`.
- Addresses are compared in lower case, exactly, with no `+tag` or dot rules. Two people cannot share an address (the existing duplicate check).
- Guests (`role: guest`) do not sign in. They reach agents through channels only, as today.
- Changing a person's address takes effect at once: an unspent link to the old address stops working, because the link is checked against the people list when it is spent, not only when it is sent.

### 3. The email link

- The person types their address. The page always says "If this address may sign in, a link is on its way", whether the address is known or not, and takes the same time to answer. Nobody can use the form to find out who is on the list.
- The link holds a one-time code (32 random bytes). It lasts 15 minutes, works once, and only its hash is kept, in `.agentx/signin-links.json` (as with the member pairing codes in `.agentx/pair-codes.json`). Asking again replaces the earlier link.
- The link opens a page with a **Sign in** button; pressing it signs in. Mail apps and company filters often open links on their own to check them; with the button, that check does not use up the link.
- The link starts with `wall.signIn.origin`, the fixed HTTPS address of the Wall, never with the address the request came in on, so a forged `Host` header cannot send a link that points elsewhere.
- Limits per address and per network address (for example 5 links an hour per address, 20 per network address) stop the form being used to flood someone's inbox or run up the provider bill.
- The mail is plain and short: who it is from, the link, how long it works, and "you can ignore this if it was not you". No tracking pixels and no click tracking: the provider must not rewrite the link (see [Decision 4](#4-the-mail-provider)).

### 4. The mail provider

AgentX stays generic: it knows a **mail sender**, not a company. The owner's sender is Mailgun, set up like any other.

- A new, small block in `agentx.json` names one sender: the `from` address and name, and how to reach the provider. It is not an email account (`channels.email.accounts`), because those belong to an agent and need an IMAP inbox; this sender only sends.
- The proposal is one kind of sender to start with: **SMTP**. Mailgun, like most mail providers, accepts mail over SMTP with a login for the sending domain, so it needs no code written for Mailgun. The sending reuses `sendMail` from `src/channels/email/smtp.ts` (nodemailer), split so it does not need an agent's account.
- Example, with made-up values:

  ```json
  "mail": {
    "sender": {
      "kind": "smtp",
      "from": "no-reply@mg.example.com",
      "name": "Example Wall",
      "host": "smtp.example-mail.net",
      "port": 587,
      "user": "${AGENTX_MAIL_USER}",
      "password": "${AGENTX_MAIL_PASSWORD}"
    }
  }
  ```

  and in `.env`:

  ```
  AGENTX_MAIL_USER=postmaster@mg.example.com
  AGENTX_MAIL_PASSWORD=...
  ```

- **Keys never go in the repo.** `user` and `password` must be `${VAR}` references; a literal password in `agentx.json` is refused when the config loads, with a message saying to move it to `.env`. Logs and the dashboard show the sender's `from` and host, never the login or password.
- Another provider, or the owner's own mail server, is the same block with other values. A provider that only offers a web API (no SMTP) would be a second `kind` later, still written for the API style, not for one company. Not proposed now.
- **In the provider's settings** (done once by the owner, outside AgentX): turn off click tracking and open tracking for the sending domain, so the link in the mail is the Wall's own link.
- `agentx mail test <address>` sends one test mail through the sender, so the owner can check the setup without signing anyone in.

### 5. Sign in with Google, on standby

Google is a configured **sign-in provider**, as Mailgun is a configured mail sender: nothing in the code is written for Google only, and the button appears only when the provider is set.

**Where it stands.** The access check on #1478 (2026-10-30) found no usable access: the owner's saved Google Cloud logins have expired, the `gcloud` CLI is not installed, and no OAuth client exists in any project. The one working service account belongs to another product's project and cannot make OAuth clients, so it is not used. Until that changes, the email link ships alone and nothing below is built.

**What unblocks it** (the owner, once, outside AgentX):

1. In a browser, open the Google Cloud console and pick a project the owner already has.
2. Go to APIs & Services, then Credentials, and create an OAuth client of type "Web application".
3. Add the return address `https://<the Wall's address>/signin/oidc/done`.
4. Put the client id in `agentx.json` and the secret in `.env`, as in the settings below.

A Web OAuth client for sign-in costs nothing. If any step asks to turn on billing or a paid API, stop and ask first (#1478: nothing billable without asking).

**How it would work, once set:**

- Standard OpenID Connect ("Sign in with Google" is one case of it): code flow with PKCE, `state` and `nonce`, scopes `openid email` only. The provider's address comes from its discovery document (`issuer`), so another OpenID Connect provider is the same settings with other values.
- The answer counts only if the address is marked **verified**. An optional `hd` limits it to one Workspace domain.
- It matches the **same people entry** as the email link: the `email:` identity. After the first sign-in, the Wall adds `oidc:<issuer>#<subject>` to the person, and later sign-ins match that id, so a new account that takes over an old address does not get in.
- The code exchange goes from the Wall to the provider directly; the browser never holds the provider's tokens, and the Wall keeps none of them.
- A public address is not needed: the provider sends the person's browser back to the return address, and never calls the Wall itself.

### 6. What each role sees

There is no read-only Wall today, so this is the largest new piece. The proposal, until the owner says otherwise ([question 2](#questions-for-the-owner)):

| Role | After sign-in |
|---|---|
| owner | The whole Wall, as on this machine today, writes and settings included ([question 4](#questions-for-the-owner)). |
| member | The Wall read only, as drawn in round 2 of Wall v2 for "anyone else" (#1451): the feed, Needs the owner without buttons, Running now, Projects, Activity, Agents, People, Org. Plus **My work**. No Settings, no Cost. |
| client | **Your project** only, as today. No Wall until #1479 decides who sees which mesh. |
| guest | Cannot sign in. |

- Each Wall read checks the role on the server. Hiding a nav item is not the guard.
- Writes keep the #1454 guard. A member's session never passes `wallOwnerOk`.
- A signed-in member or client also reaches `/member` without pairing a machine. Pairing stays for those who prefer it, and for the phone app.

### 7. Publishing the Wall for signed-in people

The whole dashboard must never be published (see `docs/jobs/members.md`). So the proposal is a small, fixed set of published paths, like the member page has:

- `/signin` (the form and the page the link opens) and `/api/signin`;
- `/w` (the Wall for signed-in people) and `/api/w` (its reads, which accept **only** a personal session, never "local caller" or the token).

A request on these paths without a personal session gets the sign-in page, never the owner's view, even when it reaches the dashboard from its own computer through `tailscale serve`. `agentx people invite` and `agentx app` already check for over-published paths; the same check covers these.

### 8. The first sign-in

- The proposal: a person's **first** sign-in raises an approval card ("Dana signed in for the first time, from Chrome on a Mac. Let them in?"), the same card as a new member machine (`createCard` in `members/pairing.ts`). Until the owner says yes, Dana sees "Waiting for the owner", as a new member machine does.
- Later sign-ins of the same person, from any browser, go straight in, and appear on their People page.
- A setting lets the owner skip the card for members ([question 3](#questions-for-the-owner)). For clients, the card stays.

### 9. One identity for every mesh (#1479)

#1479 makes this sign-in the people layer across meshes: outside people are let in once, on the Wall. This design keeps that open:

- The person signs in on one machine only, the Wall's home machine. Sessions, links and the mail sender live there.
- When the Wall reads or acts on another mesh, it uses that mesh's own key, as #1479 says ("no mesh trusts another more than it does today"). The person id travels with the request so the other mesh can record who asked, but it is not a credential there.
- A role per mesh (for example a supplier who sees only one mesh) is a later field on the person (`meshes`). It belongs to the #1479 design, not to this one.

### 10. What is logged

Every link asked for, link sent, refused sign-in (unknown address, used or old link, too many asks), failed send, first-sign-in card, sign-out and **End access** goes to `.agentx/members-log.jsonl`, next to the member events. The log holds the person id (or "unknown"), never the address typed for an unknown person, never the link code, and never the provider's login.

## Settings this would add

None of these exist yet. Each one gets a docs page or section in the same change that adds it (CLAUDE.md, Documentation Rule).

| Setting | Where | Meaning |
|---|---|---|
| `wall.signIn.origin` | `agentx.json` | The fixed HTTPS address of the Wall, used in the links in mails. Unset: no sign-in form. |
| `wall.signIn.firstSignIn` | `agentx.json` | `card` (default) or `auto` for members. |
| `mail.sender` | `agentx.json` | The mail sender: `kind` (`smtp`), `from`, `name`, `host`, `port`, `user`, `password`. Unset: no sign-in form. |
| `AGENTX_MAIL_USER`, `AGENTX_MAIL_PASSWORD` | `.env` | The provider login, referenced from `mail.sender` as `${VAR}`. The names are the owner's choice; these are the defaults in the docs. |
| `agentx mail test <address>` | CLI, new | Sends one test mail through `mail.sender`. |
| `wall.signIn.oidc.issuer` | `agentx.json` | On standby ([Decision 5](#5-sign-in-with-google-on-standby)). The sign-in provider, for example `https://accounts.google.com`. Unset: no provider button. |
| `wall.signIn.oidc.clientId` | `agentx.json` | On standby. The OAuth client id. |
| `wall.signIn.oidc.clientSecretEnv` | `agentx.json` | On standby. The name of the `.env` variable holding the client secret (default `AGENTX_OIDC_CLIENT_SECRET`). |
| `wall.signIn.oidc.hd` | `agentx.json` | On standby. Optional: only accounts of this Workspace domain. |
| `agentx people link <id> email:<address>` | CLI, exists | How the owner lets a person sign in. No new command. |

## How it would be built, once accepted

Small slices, each one usable and tested on its own:

1. Personal sessions: the store, the `ax_person` cookie, "which person is this?" in the gates, sessions on the People page with **End access**. Covered by tests that a member session is refused by every owner gate in the [Decision 1](#1-a-personal-session-not-the-token-cookie) list, counted again when the slice is built.
2. The mail sender: `mail.sender`, the `${VAR}`-only check, the shared SMTP send, `agentx mail test`. Tests use a fake SMTP server; nothing is sent to a real provider in tests.
3. Email link sign-in, with the published `/signin` paths.
4. The read-only Wall for members on `/w` (uses the round 2 "anyone else" designs from #1451).
5. The first-sign-in card.
6. On standby: sign in with Google (OpenID Connect). Built only once the owner has made the OAuth client ([Decision 5](#5-sign-in-with-google-on-standby)); tests use a fake provider.

## Questions for the owner

The old question "which mail service sends the links" is answered: Mailgun, as a configured sender.

1. **Network.** Does the Wall stay on the private network, with sign-in on top (people outside reach it through a Tailscale share, as members do today)? Or does it get a public address? The links need a fixed HTTPS name the person's browser can reach, for example the machine's Tailscale name `https://studio.example-tailnet.ts.net`, not a public one. A public address would let clients and suppliers in without Tailscale, but puts the sign-in page on the open internet. *Proposal: private network first; a public address later, as its own decision.*
2. **Roles on the Wall.** Is the member view in [Decision 6](#6-what-each-role-sees) right? Should a client see anything of the Wall now, or wait for #1479?
3. **First sign-in.** Always an approval card, or automatic for anyone on the people list? *Proposal: a card for the first sign-in of each person; members can be set to automatic.*
4. **The owner signing in by link (or Google, later).** Should the owner's address give full owner rights from any browser, as the dashboard token does today? Or should owner rights stay with the token and this machine, and a sign-in as the owner give the member view? With a link, whoever reads the owner's mailbox can become the owner. *Proposal: full owner rights, with the first owner sign-in from each new browser confirmed on this machine.*
5. **Cookie.** [Decision 1](#1-a-personal-session-not-the-token-cookie) uses a new cookie (`ax_person`) instead of reusing `ax_session`, so a member session can never be mistaken for the owner. Is that change from the issue fine?
6. **Sending address.** Which address do the links come from? *Proposal: a `no-reply@` address on the domain already set up for sending at the provider, so no new domain setup is needed.*
7. **SMTP or the provider's API key.** The scope on #1478 mentions an API key and a sending domain. The proposal uses the provider's SMTP login instead (also issued per sending domain), because SMTP needs no provider-specific code. Is an SMTP login fine, or must it be the API key? The API key would need a second `kind` of sender ([Decision 4](#4-the-mail-provider)).

## Not proposed

- **Email and password**, as the issue says: it needs password storage, reset and lockout flows, and a link does the same job with less to protect.
- Sign-in with any other outside account (Microsoft, GitHub, Apple). The OpenID Connect part would make that a settings change later, but it is not in scope.
- **Provider keys, or a code path for one provider only (Mailgun or Google), in the repo.** Senders and sign-in providers are configured; their secrets stay in `.env`.
- Creating anything billable in Google Cloud without asking the owner first.
- Letting people add themselves. The owner still adds each person to the list.
