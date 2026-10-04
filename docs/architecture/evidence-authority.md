# Evidence authority and the memory backend contract

Status: **proposed**, for review in [#604](https://github.com/anis-marrouchi/agentx/issues/604). Nothing here is switched on. No agent reads or writes through this contract yet, and no memory service is installed.

This page records one decision: when AgentX uses a memory backend (a service that indexes what agents know so they can search it), **AgentX decides what is true, who may read it and how fresh it is. The backend only finds things.**

## Why this is needed

Agents draw on two kinds of knowledge:

- **Approved knowledge**: wiki articles that a person reviewed, and facts in the fact ledger (the wiki's list of checked facts).
- **Recent observations**: raw entries, agent memory and task results that nobody has curated yet.

A backend that indexes both can return a three-week-old wiki line next to yesterday's task result, or a summary it wrote itself. Without a shared rule, the agent cannot tell which one to trust.

## The decision

1. **One record shape for everything.** Approved knowledge and recent observations use the same record, called *evidence*. Each record says what it is, where it came from, when it was true, who checked it and who may read it.
2. **AgentX keeps the records. The backend keeps an index.** The backend receives a copy of the text and an ID. On a search it returns IDs. AgentX then reads its own record and shows that. A backend can be rebuilt, replaced or switched off without losing anything.
3. **A backend cannot raise trust.** Text a backend writes itself (a summary, an "observation") is always shown as unverified, and never replaces a fact.
4. **No second wiki.** The wiki stays the only curated reference. Evidence records point at wiki articles and facts; they do not copy their role.

## What a record carries

| Field | Meaning | Reused from |
|---|---|---|
| ID | The same source version always gets the same ID. An edit gets a new one. | new |
| Kind | `approved` (reviewed wiki article), `fact` (ledger fact), `observation` (uncurated), `derived` (written by a backend) | new |
| Source and version | What it was made from, such as a wiki article path or a task, and which version | wiki versions (#94) |
| Event time | When it happened or was observed | new |
| Ingestion time | When AgentX stored it. **Never used to judge freshness** | new |
| Check | When it was checked, by whom, how, and whether a person confirmed it | fact ledger (#273) |
| Volatility and expiry | How fast this kind of fact goes out of date (billing: 2 days; a name: never) | fact ledger (#273) |
| Scope | Owner agent, access (`private`, `shared`, `public`), shared-with list, optional project | wiki access rules |
| Trust | `operator`, `internal` or `external`, from the channel it arrived on | capture trust (#97) |
| Review | External records are held until a person approves them | capture trust (#97) |
| Approval | Who reviewed an approved article, and when | promotion review (#95) |
| State | `active`, `superseded`, `revoked` or `deleted` | new |
| Derived from | For backend-written text: the records it was written from | new |

Code: `src/evidence/types.ts`.

## How far a record can be relied on

Every record is returned with one of four labels. The label is never left out.

| Label | When |
|---|---|
| **approved** | A reviewed wiki article |
| **verified** | Checked, and the check is still within its expiry time |
| **stale** | Checked once, but the check has expired. Re-check before stating it |
| **unverified** | Nobody checked it, the check date cannot be read, or a backend wrote it |

Expiry is counted from the check, not from when the record was stored. Storing an old claim today does not make it fresh.

## Which record wins

When a new record disagrees with the current one about the same thing:

| Current record | New record | Result |
|---|---|---|
| A fact with an old or expired check | Checked more recently | The new one **replaces** it. The old one is kept as superseded |
| A fact | Not checked | **Conflict**: the current one stands, both are kept, a person is asked |
| A fact checked more recently | Stored later but checked earlier | **Conflict** |
| A fact a person confirmed | Checked more recently by an agent | **Conflict**. Only another person's confirmation replaces it |
| Any fact | Confirmed by a person | The new one **replaces** it |
| Any | Written by a backend | **Ignored** as evidence. Nobody is asked |
| Any | From an external source, not yet approved | **Ignored** until a person approves it |
| An approved article | Any observation or fact, even one a person confirmed in a chat | **Conflict**. Approved text changes only through its review |
| An approved article | A reviewed new version of the same article | The new version **replaces** it |

A conflict uses the wiki's existing question queue (`agentx wiki questions`). Until a person answers, a search returns both records, each with its source and label, and marks them as disagreeing.

These are the fact ledger's existing rules, applied to every kind of record. Code: `resolve` in `src/evidence/authority.ts`.

## Who may read a record

- The scope is set by AgentX when the record is made, from the source's own access rules.
- The reader is the agent running the task. AgentX takes it from the task. It is never taken from what a model wrote, and never from a label or "bank" name in the backend.
- Access is checked **twice**: AgentX tells the backend which partitions to search, then checks every returned record again against its own copy before anything is summarised or shown. The second check is the one that counts.
- A backend-written summary is shown only if the reader may read every record behind it.

A record with a project set is readable only by an agent working on that project. Which project boundaries AgentX can actually enforce today is a question for the audit in [#603](https://github.com/anis-marrouchi/agentx/issues/603); until it answers, treat the project field as reserved.

## What makes a backend's answer invalid

| Event | Effect |
|---|---|
| A source is edited | The new version gets a new ID. The old record becomes `superseded` and is removed from the backend. A result that names the old version is dropped |
| A record is revoked or deleted | Its state changes, its text is removed, and it is deleted from the backend. AgentX keeps the ID and the state so a late result can be recognised and dropped |
| A record a summary was written from is edited, revoked, deleted or unreadable | The summary is dropped |
| The backend returns an ID AgentX never issued | Dropped |

Code: `gate` in `src/evidence/authority.ts`.

## The backend contract

A backend provides four operations and no more (`src/evidence/backend.ts`):

| Operation | What it does |
|---|---|
| `upsert` | Store or replace records by ID. Sending the same record twice changes nothing |
| `retrieve` | Search the partitions AgentX names. Return IDs, source versions and scores, plus any text the backend wrote and the IDs it wrote it from |
| `delete` | Remove records and everything derived from them |
| `health` | Say whether the backend is usable, and why not |

Every operation can be cancelled. If a backend fails, the task continues and the agent is told that this source gave no evidence; it is never told that nothing is known.

Because AgentX holds the original records, exporting them or moving to another backend needs nothing from the backend.

## What does not change

- **Promotion review (#95):** lessons still wait for a person before they become wiki articles. A backend cannot write an approved record.
- **Capture trust (#97):** secrets are never stored, and external-source records stay held until approved.
- **Fact checks (#273):** an agent still re-checks an expired fact against its source, or says it is unverified.
- **Approvals are not permissions.** A record that says someone approved an action in the past tells an agent what happened. It never allows the agent to do that action again. Permission comes from the current task and its approval steps only.

## Open points for review

1. Where the records are stored (a file per agent, or the existing database). This belongs to the capture work in [#606](https://github.com/anis-marrouchi/agentx/issues/606).
2. Whether project scope can be enforced today (see above; waits for #603).
3. Whether a conflict with an approved article should open a wiki question, a promotion proposal, or both.
4. The audit in #603 may show capture gaps that need a field this record does not have. The record is not final until that audit is read against it.

## Check it worked

This page describes a contract, not a feature you can switch on. To check the rules hold:

1. **Terminal:** in the AgentX checkout, run `pnpm vitest run test/evidence-authority.test.ts`.
2. Every case passes. The case named "a stale wiki fact against a newer verified result" shows the newer checked result replacing the old fact.

## If something is wrong

- **A case fails after a code change:** a rule above was changed. Either restore it, or update this page and the case in the same change so a reviewer sees the rule moved.
- **A rule here disagrees with how the fact ledger behaves:** the ledger (`src/wiki/facts/ledger.ts`) is the behaviour in use today. Report the difference on #604.
