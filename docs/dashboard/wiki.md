# Wiki: browse what your agents know, by kind of thing

Your agents write what they learn into a shared wiki. Each agent keeps its own pages, so the same person or server can have several. The **Wiki** view merges them into one page per real thing and sorts every page into a small set of **pillars**: Parties, Places & Jurisdictions, Assets, Offerings & Projects, Agreements, Law & Obligations, Events, Decisions & Policies and Procedures.

Each page opens at the level of detail that suits its kind. A person shows roles over time, relations and belongings. A device shows its state, events and installed apps. An obligation shows who must do what, by when, and the law it comes from.

Two words used on this page:

- **Type**: the kind of thing a page is about, such as Person, Organization, Device or Obligation. Each type belongs to one pillar.
- **Statement**: one typed fact on a page, such as "Sample Owner, role at Example Company, founder, since 2019-04". Every statement keeps its source.

## Open it

1. **Browser:** open the dashboard and go to `/admin/wiki/`.
2. Or, **Terminal:** run `agentx wiki serve` and open `http://localhost:4200`.

The sidebar holds only **Home**, up to five pinned pages and the pillars.

![Wiki home: the sidebar with Home, three pinned pages and the nine pillars; on the right a card per pillar with its page count, recent events and a Needs attention list](/screenshots/wiki/home.png)

## Zoom in, one level per click

| Level | What you see |
|---|---|
| **Z1 Pillar** | The types inside the pillar as tabs, the five most active pages of the open type, and what needs attention. **open list** shows every page of that type. |
| **Z2 Page** | One thing through its type's **lens**: a summary, then the panels for that type, each with its first few items. |
| **Z3 Panel** | One panel in full: every role, every event with minor ones unfolded, every installed app. Long lists have pages. |
| **Z4 Statement** | One fact: its value, when it was true, when it was recorded, the source, which agent wrote it, who confirmed it and earlier versions. |

1. Click a pillar in the sidebar. Its page opens at Z1.

   ![The Assets pillar: tabs for Devices, Servers, Apps, Domains, Accounts and Agents; the Devices tab lists the most active devices; Needs attention on the right shows a domain renewal that is late](/screenshots/wiki/pillar.png)

2. Click a page. It opens at Z2. A person page shows roles over time as a timeline:

   ![A person page: roles over time as bars, relations, belongings, obligations they carry, history with a major event, and the lens and provenance on the right](/screenshots/wiki/person.png)

   A device page shows its latest readings, its events with minor ones folded, and the apps installed on it:

   ![A device page: state now with disk used 91%, history with six minor disk warnings folded into one recurring line, installed apps, and the owner](/screenshots/wiki/device.png)

3. Click **all (Z3)** on a panel to see all of it.
4. Click **Z4** next to a fact to see where it comes from.

   ![A statement page: subject, property with its Wikidata id, value, role, the dates it was true, when it was recorded, the source, the agent that wrote it, status and access](/screenshots/wiki/statement.png)

The per-agent view is still there: click **Agent wikis** at the top.

## Event importance

Every event is **minor**, **normal** or **major**. Pages show major and normal events and fold minor ones under a count. When five or more minor events happen in 30 days, the page shows them as one **Recurring** line. Only the owner sets **major**; an agent can propose it.

## Private facts

A statement marked `access: private` (an ID number, an account number) shows as `••••` on Z2 and Z3. Its value appears only on its Z4 page. The **Discussed** panel lists the conversations a page was written from and is marked private to the owner.

## Change the pillars, types and lenses

The wiki uses built-in defaults until you write your own `ontology.yaml` in the wiki folder.

1. **Terminal:** run `agentx wiki ontology init`. It writes `.agentx/wiki/ontology.yaml` with every default.
2. Open the file and change what you need. A section you delete falls back to the default. Types, pillars and relations merge by `id`.
   - Pin pages: list up to five page titles under `sidebar.pins`.
   - Reorder or hide a panel: edit `lens` under the type.
   - Add a type: add an item under `types` with an `id`, a `label` and a `pillar`.
   - Change how old pages get a type: edit `classify`. Rules are tried in order, by old page type, folder, tag or title.
3. **Terminal:** run `agentx wiki ontology check`.
4. Reload the wiki page. There is no restart.

A short example:

```yaml
sidebar:
  pins: [Sample Owner, Example Company]
types:
  - id: vehicle
    label: Vehicle
    plural: Vehicles
    pillar: assets
    lens:
      - {panel: parties, title: Owner, from: [owns, uses]}
      - {panel: history, source: history, fold: minor}
```

## How a page gets its type

1. A page that sets `class:` in its header uses that type.
2. Otherwise the `classify` rules decide, from the page's older `type`, its folder, its tags or its title.
3. A page no rule matches goes to **Topics**, which is not in the sidebar. A growing Topics count means a type is missing.

Statements are written in the page header as one line of JSON:

```yaml
class: device
statements: [{"property":"owns","value":"Office Laptop","since":"2025-02"},{"property":"reading","metric":"disk_used","value":"91%","at":"2026-10-02"}]
```

## Check it worked

1. **Terminal:** run `agentx wiki ontology show`. It prints the number of pages per pillar and type.
2. **Browser:** open `/admin/wiki/`. The sidebar shows Home, your pins and nine pillars.
3. Open a person or a device. The panels match the lens for its type, listed on the right under **Lens for this type**.

## If something is wrong

- **A red box says ontology.yaml has problems:** your file has lines the wiki can't use, and the defaults are used for them until you fix them. **Terminal:** run `agentx wiki ontology check` and fix each line it prints.
- **A page sits in the wrong pillar:** no rule gave it the right type. Add `class: <type>` to its header, or add a `classify` rule for its folder, tag or title.
- **Two pages for the same thing are not merged.** Pages merge when their titles or `aliases` match. Add the other title to `aliases:` on one of them.
- **A pinned page does not show.** The pin must match a page title or alias exactly, ignoring case and punctuation. Only the first five pins show.
- **The old home page with agent cards is gone.** It moved to **Agent wikis** (`/agents`).
