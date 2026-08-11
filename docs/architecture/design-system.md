# Design system

The dashboard's visual language is ported from the **agentina** console. This
page records what was taken, what was deliberately left, and why — so future
changes argue with a stated position rather than drift.

Tokens live in `src/daemon/ui/tokens.ts` (single source of truth, imported by
every page). Component classes live in `src/daemon/ui/components.css.ts`.

## The three principles

Carried over verbatim, because they are as much about what we remove as how it
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

## Palette

Four brand colours and a neutral ramp. Anything outside this list is a bug.

| Role | Light | Dark | Use |
|---|---|---|---|
| Blue | `#2979FF` | `#6BA5FF` | Primary action, links, live state |
| Blue dark | `#1B5FD9` | `#1B5FD9` | Offset shadow under primary |
| Blue tint | `#E7F0FF` | `#16233d` | Selected chips, info panels |
| Green | `#22B573` | `#4ED89B` | Success, healthy, online |
| Amber | `#FFB300` | `#FFC948` | Warning, needs attention |
| Red | `#F23A3A` | `#FF6B6B` | Error, destructive, denied |

Neutrals (light): text `#202124` · secondary `#5f6368` · muted `#9aa0a6` ·
border `#e8eaed` / `#dadce0` · surface `#ffffff` · ground `#f8f9fa`.

## Shape

The part that makes it recognisable:

| Token | Value | Note |
|---|---|---|
| `--ax-border-w` | `2px` | Was 1px. The single biggest visual shift |
| `--ax-radius` | `16px` | Was 6px |
| `--ax-radius-lg` | `20px` | Cards |
| `--ax-radius-sm` | `12px` | Inputs, small controls |
| `--ax-radius-pill` | `999px` | Chips, badges, status labels |
| `--ax-shadow` | `0 3px 0 <border>` | Solid, **un-blurred** |
| `--ax-shadow-accent` | `0 4px 0 <blue-dark>` | Primary buttons |

The offset shadow is the signature move: a solid drop in a darker shade of the
element's own colour, with no blur. It reads as a physical edge rather than a
glow, and it is what stops flat 2px-bordered boxes from looking like a
wireframe. Buttons collapse it on `:active` (`translateY(2px)` +
`0 1px 0`) so the control visibly sinks — which is the entire justification for
an un-blurred shadow over a soft one.

## Type

`Outfit` for UI, `Roboto Mono` for code, ids, and any tabular number.

Loaded from Google Fonts with real system fallbacks in the token, so an
offline or air-gapped box loses typography but never layout.

## What was deliberately not ported

**Light-only.** agentina is a consumer console with one light theme. This is a
dense operations dashboard people read at 2am, so the dark variant stays and
carries the same shape language with the brand colours lifted toward their
tints for contrast. The offset shadow inverts: darker than the surface in dark
mode, where agentina's would disappear.

Dark is not a tint of light. Both palettes are written out in full in
`tokens.ts` rather than derived, because a derived dark theme is how contrast
bugs get shipped.

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
launchctl kickstart -k gui/$(id -u)/tn.noqta.agentx-dashboard   # macOS
curl -s localhost:4202/live | grep -c -- "--ax-blue"            # tokens present
```

Then look at `/live` and `/admin` in **both** themes. Rendering a page 200 is
not evidence that it looks right.
