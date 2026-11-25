## Score against the orca-design checklist: 20 / 20

Scored 2026-11-25 23:52Z by dev-session. It covers all 14 mocks (13 Settings sections and the #2149 menu editor). A row passes only when all 14 files pass. Proof is a DOM check of every file at 1440 px in light and dark, a 390 px overflow check, and a look at the PNGs.

Four misses came up on the first pass. I fixed all four in the mocks before scoring, and the "Before the fix" column lists them.

| # | Check | Result | Proof | Before the fix |
|---|---|---|---|---|
| C1 | One pane at a time, grouped side menu, 11 px uppercase labels | 1 | 5 groups (General, Work, People, Connections, System), one pane per file | |
| C2 | Search at top of side menu with shortcut chip | 1 | `⌘F` / `Ctrl+F` chip; Enter jumps to the row and flashes it, in this pane or another (guests→Jobs, general→Menu, whatsapp→Agent tested) | Index was split three ways: Guests found only its own rows, and the first batch could not find Jobs/Menu rows. Now one index of 174 rows in all 14 files |
| C3 | Content capped about 784 px and centred; side menu about 280 px | 1 | side menu 280 px, content `max-width:784px` | |
| C4 | Group titles outside cards; rows split by hairlines | 1 | h3 15 px above each card, `border-t` between rows | |
| C5 | No card inside a card | 1 | 0 nested cards found | |
| C6 | Neutral palette; colour only for state, focus, one primary | 1 | Greys carry the chrome; blue only for changed-value dot, focus and the one primary; amber/green only for status. Engine logos keep brand colours (see exception below) | |
| C7 | Hairlines as default; shadows only when floating; ≤3 levels | 1 | 3 shadows: `shadow-xs`, `shadow-floating` (popovers), dialog | |
| C8 | Type scale; Geist; mono for ids | 1 | 24 / 15 / 14 / 12.5 / 11 px; only Geist and Geist Mono found; ids, paths, models, cron in mono | |
| C9 | lucide icons only, size-4 default | 1 | lucide everywhere; logos are the only non-lucide marks | |
| C10 | Light and dark both correct, tokens not hex | 1 | CSS tokens; dark `--border: rgb(255 255 255/.07)` | |
| C11 | One primary per flow; Cancel/Close quiet | 1 | Primary only in the save bar (Agent "Review and save", Inbox); Discard and Cancel are ghost buttons | |
| C12 | Row actions in `…` menu; rare settings under Advanced | 1 | `…` per row (Orca allows it visible); Advanced on 8 panes where rare settings exist | |
| C13 | Right picker: Select for short lists, Command-in-Popover for models | 1 | Agent → Model is a searchable popover grouped by engine (`agent-model-picker-*.png`) | Model picker was a plain list without search |
| C14 | Every icon-only button named; shortcut chip per platform | 1 | 0 icon-only buttons without a name (1 hit was the hidden dialog button, labelled when opened); chip shows ⌘ on Mac, Ctrl elsewhere | |
| C15 | Empty and error states give an action | 1 | "No settings match" → Clear search; empty lists → Add …; ops token warning says how to move it | |
| C16 | Focus-visible rings; Enter/Esc work | 1 | `:focus-visible` in all 14; Esc closes popover, dialog and search | |
| C17 | Sentence case, one help line ≤80 chars, no please/simply/just | 1 | 0 help lines over 90 chars; only "just" is "what just happened" (meaning, not filler) | Inbox "Banner icon" help was 104 chars, cut to 79 |
| C18 | Motion <300 ms, ease-out, from scale ≥0.95 | 1 | 120–200 ms; popovers 0.98, dialog 0.95, origin from trigger. The 3 s search-hit flash is a fading highlight, not a motion | |
| C19 | No animation on keyboard-opened panes or frequent actions | 1 | Pane opened by keyboard uses `fadeOnly`, not the slide | |
| C20 | `prefers-reduced-motion` honoured; hover gated | 1 | reduced-motion block in all 14; hover rules inside `@media (hover:hover)` | |

**Other checks (all 14 files, 1440 and 390, light and dark):** 0 console errors, 0 cut-off text elements and no sideways scroll on the phone.

**Exception to C6, logo colours:** engine logos (Claude Code, Codex and the other engines) keep their brand colours. This is the only exception to "colour only for state". The logos come from PR #2276 `engine-icons.ts` (lobehub, MIT).

**Friction notes (not scored):**
1. On the phone, the Channels → Telegram row for `ops` wraps to four lines, because its "Token in agentx.json" badge shares the line with the name. In the PR, move the badge under the name when the screen is under 640 px wide.
2. In the Menu editor, the `…` button shows on every row at rest. Orca allows this, but hiding it until hover on pointer devices would make the list quieter.
