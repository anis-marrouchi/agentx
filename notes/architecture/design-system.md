# Design system

This page records where the dashboard's look comes from, what is AgentX's
own, and why, so that future changes argue with a stated position instead of
drifting.

Tokens live in `src/daemon/ui/tokens.ts` (single source of truth, imported by
every page). Component classes live in `src/daemon/ui/components.css.ts`.

## The three principles

Carried over from the agentina console, because they are as much about what we remove as how it
looks:

1. **Contacts, not concepts** — surface the people and agents you work with.
   Grants, sessions, adapters and process pools are machinery; they belong in
   detail views, not on a landing page.
2. **One screen, one job** — a flow is a short wizard with one obvious next
   action, not a dense panel exposing every option at once.
3. **Honest UI** — nothing simulated. Offline is offline, denied is denied, and
   a number nobody computed is absent rather than zero.

Principle 1 is why the settings page opens on *your agents* and not on a config
tree. Principle 3 is why an unreachable mesh peer greys out instead of
optimistically rendering.

## Where the look comes from (#2101)

Since 0.252.0 (#2111, #2127) the base follows Orca's desktop app (MIT,
credited in `tokens.ts`): a neutral shadcn-style look with 1px lines, a 10px
radius, Geist type and no hard offset shadows. People who know Claude Code,
Codex, Gemini CLI or Orca should feel at home. It replaced the agentina look
(2px borders, 16px radius, un-blurred offset shadow, Outfit).

What stays AgentX's own, so it is not a copy (owner, 2026-11-22: "make sure
things stay distinct and unique"):

1. **The AgentX blue** for the primary button, links, focus and the current
   place. Orca is monochrome. Blue only, no purple.
2. **The name, logo and icon.**
3. **Status colours that mean something**: green done/online, amber needs you,
   red failed/refused, grey off.
4. **The three principles above.**
5. **Offline fonts**: Geist is served by the daemon, no font CDN.

The values, parts and layout are written down for people and design tools in
`skills/agentx-design/SKILL.md`. `test/design-skill.test.ts` fails if that file
quotes a value `tokens.ts` no longer has, so change both together.

## Palette

Values live only in `tokens.ts`. The skill's colour table lists each role.
Rules that hold across changes:

- The primary button is `#1f66e5` in both themes, so its white label stays at
  5.1:1 (white on `#2979FF` is only 3.98:1). `test/design-tokens.test.ts`
  checks it.
- Amber and red are fills. Text in those colours uses `--ax-amber-ink` /
  `--ax-red-ink`.
- Dark is not a tint of light. Both palettes are written out in full, because
  a derived dark theme is how contrast bugs get shipped.

## Shape and type

1px lines, 10px radius (14px large, 6px small, pill for chips), no shadow on
flat cards, and a soft shadow (`--ax-shadow-lg`) only on things that float:
menus, dialogs, the drawer. Geist for UI, Geist Mono for code, ids and any
tabular number.

## Themes

Light and dark. With no saved choice the page follows the computer's setting
(`AX_THEME_BOOT`, key `ax-theme`).

## What was removed

**The `crt` theme.** Two well-maintained themes beat three, and it had no
users. The theme bootstrap migrates a stored `crt` preference to dark rather
than leaving `data-theme` set to a value no stylesheet defines.

## Adding tokens

Every token must be page-neutral. Page-specific padding and gaps belong in that
page's own CSS block, not in `tokens.ts`. If a value is needed by exactly one
page, it is not a token.

The `--bg` / `--card` / `--text` aliases at the bottom of `tokens.ts` exist so
older CSS blocks keep rendering while they are ported. Do not add new ones.

## Verification

The dashboard renders from a TypeScript template literal, which has a known
escaping hazard (`\n`, `\'`, `\"` inside inline `<script>` collapse and break
parsing). agentina's `console.test.ts` guards this with a regression test; the
same applies here. After any change to `components.css.ts` or a page renderer:

```bash
pnpm build
launchctl kickstart -k gui/$(id -u)/tn.acme.agentx-dashboard   # macOS
curl -s localhost:4202/live | grep -c -- "--ax-blue"            # tokens present
```

Then look at `/live`, `/wall` and `/app` in **both** themes. Rendering a page 200 is
not evidence that it looks right.
