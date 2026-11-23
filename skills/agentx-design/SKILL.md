---
name: agentx-design
version: 1.0.0
description: The AgentX look — colour, shape, type and parts for the dashboard, the Hub and the phone app, and what keeps AgentX distinct from Orca, the app its look borrows from. Use before you design, mock or change any AgentX screen, or when you brief a design tool (Claude Design, a mock-up) about AgentX.
tags: [agentx, design, ui, tokens, hub, dashboard, phone]
triggers:
  - pattern: "(design|mock|redesign|restyle|look|theme|colou?r|token|css|screen|page|button|layout).*(agentx|hub|dashboard|phone app|wall)|(agentx|hub|dashboard|phone app|wall).*(design|mock|redesign|restyle|look|theme|colou?r|token|css|screen|page|button|layout)"
    description: "Designing or changing an AgentX screen"
---

# The AgentX look

Every AgentX screen takes its look from one place: `src/daemon/ui/tokens.ts`
(`AX_TOKENS_CSS`). The desktop dashboard, the Hub (`/wall`) and the phone app
(`/app`) all read it. The shared parts are the classes in
`src/daemon/ui/components.css.ts`. If a value is in neither file, it is not part
of the look. The reasons behind it are in `notes/architecture/design-system.md`.

## Where it comes from, and where it differs

The base follows Orca's desktop app (MIT, credited in `tokens.ts`): a quiet,
neutral, shadcn-style look with 1px lines, a 10px radius, Geist type and no hard
shadows. People who know Claude Code, Codex, Gemini CLI or Orca should feel at
home here.

AgentX must still be recognisable as itself (owner, 2026-11-22: "make sure
things stay distinct and unique"). These are AgentX's own. Keep them, and do not
copy Orca over them:

1. **The AgentX blue.** Orca is monochrome. AgentX uses its vivid blue for the
   primary button, links, the focus ring and the place you are now. Use blue
   only. No purple and no gradients.
2. **The name, logo and icon.** These are AgentX's own. Never use Orca's.
3. **Status colours mean something.** Green means done or online. Amber means
   it needs you. Red means failed or refused. Grey means off. Never use them as
   decoration.
4. **The three principles** (below). Orca does not have them. They decide what
   appears on a screen, and the colours do not change that.
5. **Offline.** Geist is served by the daemon (`/assets/`). There is no font
   CDN, so a box with no internet keeps its layout.

When you borrow a pattern from Orca or another tool, take its layout and
behaviour, not its words, logo or exact screens.

## The three principles

1. **Contacts, not concepts.** Show the people and agents you work with.
   Grants, sessions, adapters and process pools are machinery and belong in
   detail views.
2. **One screen, one job.** Each screen has one obvious next action.
3. **Honest UI.** Nothing is simulated. Offline shows as offline and refused as
   refused. A number nobody computed is left out, not shown as zero.

## Colour

Always use the tokens. Never write a hex value in a page.

| Use | Token | Light | Dark |
|---|---|---|---|
| Primary button fill | `--ax-primary` | `#1f66e5` | `#1f66e5` |
| Label on the primary button | `--ax-primary-fg` | `#ffffff` | `#ffffff` |
| Links, current place, live | `--ax-accent` (`--ax-blue`) | `#1f66e5` | `#4d94ff` |
| Focus ring | `--ax-ring` | `#2979FF` | `#4d94ff` |
| Selected / info tint | `--ax-accent-t` | `#e8f0ff` | `#1c2b47` |
| Done, online | `--ax-ok` | `#16a34a` | `#4ade80` |
| Needs you | `--ax-warn` | `#f59e0b` | `#fbbf24` |
| Failed, refused | `--ax-err` | `#e40014` | `#ff6568` |
| Ground | `--ax-bg` | `#ffffff` | `#0a0a0a` |
| Card | `--ax-surface` | `#ffffff` | `#171717` |
| Line | `--ax-border` | `#e5e5e5` | white at 8% |
| Text | `--ax-text` | `#0a0a0a` | `#f0f0f0` |
| Second text | `--ax-text-2` | `#525252` | `#c4c4c4` |
| Muted text | `--ax-muted` | `#696969` | `#acacac` |

- Amber and red are fills. When they carry words, use `--ax-amber-ink` or
  `--ax-red-ink` instead.
- For text on `--ax-accent`, such as a count badge, use `--ax-accent-ink`.
  White on the dark-theme blue is only 3:1.
- Contrast must be at least 4.5:1 for text. `test/design-tokens.test.ts`
  checks the main pairs. Add any new pair there.
- Both themes are written out in full. Never work dark out from light.

## Shape

| Token | Value |
|---|---|
| `--ax-border-w` | `1px` |
| `--ax-radius` | `10px` (controls, cards) |
| `--ax-radius-lg` | `14px` |
| `--ax-radius-sm` | `6px` |
| `--ax-radius-pill` | `999px` (chips, badges) |
| `--ax-shadow` | `none` |
| `--ax-shadow-lg` | soft, for things that float: menus, dialogs, the drawer |

Flat cards have no shadow. Only floating layers have one.

## Type

`--ax-font` is Geist and `--ax-mono` is Geist Mono. Use mono for code, ids and
any number in a column (`font-variant-numeric: tabular-nums` is set). The sizes
are `--ax-fs` 14px, `--ax-fs-sm` 13px and `--ax-fs-xs` 12px.

## Parts

Use the existing class before you make a new one:

- `.ax-btn`, `.ax-btn--primary` (one per screen), `.ax-btn--ghost`,
  `.ax-btn--danger`
- `.ax-card`, `.ax-callout`, `.ax-field`, `.ax-chip`
- `.ax-badge` with `--accent`, `--live`, `--warn`, `--err`, `--ghost`, `--mono`
- `.ax-dot` with `--ok`, `--warn`, `--err`, `--off`, `--pulse` (state at a
  glance)
- `.ax-avatar` for agents and people

## Layout (Hub, epic #2106)

- A left sidebar (`--ax-side-w`, 232px) with the live tree of agents and their
  work.
- The middle is the chat with the agent you selected. Below it is an ask box
  for text, voice and attachments.
- There is no fixed right column. A side panel opens only when something needs
  it (a PR diff, a request plan, a file), with tabs if more than one is open.
  Otherwise the chat uses the full width.
- Chat follows what people know from Claude Code: the answer streams in, and
  tool steps fold into one line each under "Worked for …".

## Rules for changes

- A token must work on any page. Padding or spacing used by one page belongs in
  that page's CSS. Do not add new legacy aliases (`--bg`, `--card`, …).
- The theme is chosen once by `AX_THEME_BOOT` (key `ax-theme`, follows the
  system until the user picks one). Do not add a second theme switch.
- Pages are rendered from TypeScript template literals, and `\n`, `\'` and `\"`
  inside an inline `<script>` break it. Run the page's test after any change.
- Proof is a screenshot of the real page in **both** themes. A page that
  returns 200 has not been shown to look right. Do not show fleet data or costs
  in screenshots you share.

## Briefing a design tool

When you hand AgentX to Claude Design or any mock-up tool, give it this file and
`src/daemon/ui/tokens.ts`. Tell it to keep the five points under "Where it comes
from, and where it differs". Then check that its output only uses the tokens
above before any of it is built.
