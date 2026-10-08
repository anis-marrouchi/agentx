# Shape the wiki: page types, links and layouts

The shared wiki is the knowledge base every agent reads and writes. It is being rebuilt so that each real thing (a person, a company, a laptop, a tax obligation) has **one page for the whole fleet**, instead of one page per agent.

What those pages can be, and how they are laid out, is set in one file: `ontology.yaml`. An *ontology* is simply a list of the kinds of things the wiki knows about and how they relate. This page shows how to read it and change it.

Everything here happens in a **terminal** on the machine that runs AgentX, in the folder that holds `agentx.json`.

::: info Being built
This file is the first part of the new wiki ([#811](https://github.com/anis-marrouchi/agentx/issues/811)). Today you can read, check and edit it. The wiki pages and the way agents write to the wiki will use it in the next releases.
:::

## What the file holds

- **Pillars:** the main sections of the wiki, in the order the sidebar shows them. There are nine: Parties, Places & Jurisdictions, Assets, Offerings & Projects, Agreements, Law & Obligations, Events, Decisions & Policies, and Procedures.
- **Types:** what a page is about, such as a person, an organization, a device or an obligation. Each type sits in one pillar. A *kind* narrows it, for example a device of kind "laptop".
- **Links:** how two pages relate, such as "owns", "has role at" or "subject to". A link can carry details, called *qualifiers*, such as the role ("accountant") and the dates it was true. Roles like client, employer or accountant are always details on a link, never page types, because one organization can be a client on one link and a supplier on another.
- **Importance levels:** every event is minor, normal or major. Minor events stay inside the page they are about. Only major events appear in the wiki's main navigation. When the same minor event happens often (5 times in 30 days by default), the repeats become one normal event, so a recurring problem is not hidden.
- **Who confirms:** an obligation that comes from a law stays "proposed" until the owner or the accountant confirms it. Only the owner sets an event to major; agents can propose it.
- **Sidebar:** Home, up to 5 pinned pages, and the pillars. Nothing deeper.
- **Lenses:** for each type, the panels its page opens with, in order. A device page opens with its current state, its events, its installed apps, what was discussed about it, and who owns and uses it.

You don't need the file to start. Without it, AgentX uses built-in defaults.

## 1. See the ontology in use

1. Run:

   ```bash
   agentx wiki ontology show
   ```

   The first line says whether the list comes from your `ontology.yaml` or from the built-in defaults. Then come the pillars and their types, the links, the importance levels and the sidebar.

2. To see one type in detail, run, for example:

   ```bash
   agentx wiki ontology show --type device
   ```

   You get the links a device can have (a `*` marks a required detail) and the panels its page opens with.

## 2. Create your own copy to edit

1. Run:

   ```bash
   agentx wiki ontology init
   ```

   This writes the built-in defaults to `.agentx/wiki/ontology.yaml`. It never replaces a file that is already there. Add `--force` to start over from the defaults.

2. Open `.agentx/wiki/ontology.yaml` in a text editor.

You can also keep only the parts you change. Any section you delete from the file comes back from the defaults. Lenses are merged type by type, so a file with only a person lens changes the person page and nothing else.

## 3. Change a page layout

To show a person's belongings before their relations:

1. Open `.agentx/wiki/ontology.yaml` in a text editor.
2. Find `person:` under `lenses:`.
3. Move the `belongings` line above the `relations` line, and save the file.

   ```yaml
   lenses:
     person:
       - {panel: roles_over_time, from: role_at, show: 6}
       - {panel: belongings, from: [owns, uses], show: 5}
       - {panel: relations, from: [member_of, client_of, supplier_of, registered_with, party_to], group_by: role, show: 5}
   ```

   `from` names the links (or one of `facts`, `readings`, `events`, `decisions`, `due_dates`, `statements`) the panel lists. `show` is how many items the page shows before you open the full panel; it can be 1 to 6.

4. Run `agentx wiki ontology check` (step 4).

## 4. Check your changes

1. Run:

   ```bash
   agentx wiki ontology check
   ```

2. Read the result:
   - **is valid and in use:** the wiki uses your file.
   - **N problem(s):** each line names what is wrong, for example `type "vehicle" is in no pillar`. Until you fix them, the wiki keeps using the built-in defaults, so a mistake never leaves it half-configured.

## Check it worked

1. Run `agentx wiki ontology check`. It prints that your `ontology.yaml` **is valid and in use**.
2. Run `agentx wiki ontology show`. The first line reads `from` followed by the path of your file, not "built-in defaults".
3. Run `agentx wiki ontology show --type person`. The panels are in the order you set.

## If something is wrong

- **`show` says "built-in defaults" although you edited the file.** The file has a problem. Run `agentx wiki ontology check` and fix each line it lists.
- **`... is not valid YAML`.** A bracket, colon or indent is off. Compare the line with the examples above; lists use `[a, b]` or one `- item` per line.
- **`property "..." never links a ...`.** A panel reads a link that this type can't have. Run `agentx wiki ontology show --type <type>` to see the links it can have.
- **`sidebar.pins_max: Number must be less than or equal to 5`.** The sidebar holds at most 5 pinned pages.
- **`init` says the file already exists.** Your copy is safe. Add `--force` only if you want to replace it with the defaults.
- **You use a different wiki folder.** Add `--dir <path>` to each command.
