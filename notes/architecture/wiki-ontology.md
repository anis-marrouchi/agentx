# Wiki ontology: page types, link types, importance levels

Status: **draft, waiting for owner approval** (#811, step 1). No code changes until this page is approved.

This page lists what the wiki will contain once it becomes a knowledge graph: the kinds of page (types), the kinds of link between pages, and how important an event is. Everything here is a starting set. All three lists live in one settings file, so an operator can add or rename entries without a code change.

## 1. Page types

One page per real thing, shared by the whole fleet. The agent that wrote a statement is kept as the statement's **source**. It no longer decides where the page lives.

| Type id | Label (sidebar) | schema.org | What belongs here | Replaces today's `type` |
|---|---|---|---|---|
| `person` | People | `Person` | the owner, an employee, a client contact | `person` |
| `organization` | Organizations | `Organization` | the company, a client, a bank, a public agency | (new; today filed as `concept` or `project`) |
| `place` | Places | `Place` | a country, a city, an office | `place` |
| `system` | Devices & systems | `Product` / `SoftwareApplication` | a laptop, a server, an app, a phone line | (new; today filed as `concept` or `event`) |
| `rule` | Rules | `Legislation` | a tax or social-security obligation, a contract term, a house policy | (new; today re-researched each time) |
| `project` | Projects | `Project` | a product or a client engagement | `project` |
| `procedure` | Procedures | `HowTo` | how something is done here | `pattern` |
| `topic` | Topics | `DefinedTerm` | a concept that is none of the above (fallback) | `concept` |

Not page types any more:

- `event` becomes an **event entry** on the page of the thing it is about (section 3). Only major events also get their own page.
- `decision` becomes an event entry of kind `decision`, with importance `normal` or `major`.

**Identity rule.** Two pages describe the same thing when they share a strong identifier (phone number, email, tax or company number, hostname, domain) or the same name and type with no conflicting identifier. Names alone never merge a `person`. The merged page keeps every other name as an alias.

## 2. Link types

A link goes from one page to another and carries a type. Links are stored once, on the subject page, and shown in reverse on the target page (the "inverse label").

| Link id | Label | From → To | Inverse label | Qualifiers |
|---|---|---|---|---|
| `has-role-at` | has role at | person → organization | people | `role` (required, e.g. "accountant") |
| `works-on` | works on | person, organization → project | worked on by | `role` |
| `owns` | owns | person, organization → system, organization, project | owned by | |
| `client-of` | client of | organization, person → organization | clients | |
| `supplier-of` | supplier of | organization → organization | suppliers | `what` |
| `located-in` | located in | person, organization, place, system → place | located here | |
| `registered-in` | registered in | organization → place | registered here | `registration number` |
| `must-follow` | must follow | person, organization, project → rule | applies to | |
| `runs-on` | runs on | system, project → system | runs | |
| `uses` | uses | person, organization, project → system | used by | |
| `part-of` | part of | any → same type | parts | |
| `follows-procedure` | follows | project, rule → procedure | used for | |
| `related-to` | related to | any → any | related to | (fallback; today's `related`) |

**Qualifiers** (any link, Wikidata style): `start` date, `end` date, `source` (agent, entry or external system), `checked` (date the link was last confirmed). A link with an `end` date is shown as past, not deleted.

**Facts** (a phone number, an address, a fee) are not links. They stay in the existing fact ledger (`src/wiki/facts/ledger.ts`), which already records source, check date and earlier values. The entity page reads its facts from there.

## 3. Events and importance

Every event is attached to exactly one page (its **subject**) and may mention others. It has a date, a kind, an importance and a source.

Event kinds (starting set): `incident`, `change`, `decision`, `meeting`, `deadline`, `payment`, `milestone`, `note`.

| Importance | Meaning | Where it shows |
|---|---|---|
| `minor` | routine; nobody needs to act or remember it (disk full and cleared, cache flushed, a retry that worked) | only in the **History** section of its subject page, collapsed |
| `normal` | worth keeping; useful context later (a meeting, a config change, a paid invoice) | History section of its subject page and of every mentioned page |
| `major` | changes how things stand; a person should know (a client signed or left, an outage that hit a client, a rule changed, a key decision) | everything above, plus the **Major events** list in the sidebar and on the home page, and its own page |

Defaults when absorb is unsure: `normal`. Repeated `minor` events of the same kind on the same page (for example a fifth disk-full in a month) are counted and can be raised to `normal` by a rule in settings, so a pattern is not hidden.

## 4. Rule pages

A `rule` page holds an obligation once. Required sections:

- **Applies to** (filled from `must-follow` links pointing at the page)
- **What to do**
- **Deadlines** (date or recurrence, for example "15th of each month")
- **Penalty** if missed
- **Sources** (link or document reference)
- **Last checked** (date and who checked)

Agents answer a question about the rule from this page. They research again only when **Last checked** is older than the rule's `recheckDays` (default 180).

## 5. Entity page layout

1. Title, type, aliases
2. Summary (a few sentences)
3. Links, grouped by link type (including inverse links)
4. Facts, each with its source and check date (from the fact ledger)
5. History: events, newest first; minor events collapsed behind a "Show minor" control
6. Sources: which agents and entries contributed, as a footer

Sidebar and home page: one group per page type, in the order of the table in section 1, then **Major events**. The per-agent view stays reachable from a filter, not as the main grouping.

## 6. Settings file

Proposed location: `.agentx/wiki/_ontology.json`, beside the existing `_questions.json`. When it is missing, the wiki seeds it from a starter in code, the same way the intent graph seeds `.agentx/graph/schema.json` from `src/graph/starter-schema.ts`.

```json
{
  "version": 1,
  "types": [
    { "id": "person", "label": "People", "schemaOrg": "Person", "folder": "people" }
  ],
  "links": [
    { "id": "has-role-at", "label": "has role at", "inverse": "people",
      "from": ["person"], "to": ["organization"], "qualifiers": ["role"], "required": ["role"] }
  ],
  "importance": [
    { "id": "minor", "nav": false },
    { "id": "normal", "nav": false },
    { "id": "major", "nav": true }
  ],
  "eventKinds": ["incident", "change", "decision", "meeting", "deadline", "payment", "milestone", "note"],
  "promote": { "minorRepeatsToNormal": 5, "windowDays": 30 },
  "rules": { "recheckDays": 180 }
}
```

Unknown type or link ids coming from absorb fall back to `topic` and `related-to`, and are listed for review, like new verbs in `agentx graph review`.

## 7. Questions for the owner

1. Is `system` the right single type for devices and software, or should they be two types?
2. Should `decision` stay a page type of its own instead of an event kind?
3. Are the three importance levels enough, or is a fourth (`critical`) needed for alerts?
4. Pilot entities: the company, its owner, and which legal obligation?

## Next steps after approval

1. Ship the settings file and starter (no behaviour change).
2. Absorb writes typed pages, typed links and events with importance (one pipeline; #808 covers its quality).
3. Pilot reshape on three entities; review before and after with the owner.
4. Full reshape of existing articles.
5. Wiki layout by type.
