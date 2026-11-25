## Why

<!-- Close the issue with the PR. If this PR finishes the issue, write
`Closes #N`: GitHub closes the issue when the PR merges. If it does only
part of the issue, write `Refs #N` and say in one line what is left; the
PR that does the last part says `Closes #N`. No issue? Say the problem. -->

Closes #

Concrete problem:

## What changed

## Impacted

<!-- Impact sweep (CLAUDE.md, Rule A). One line per surface this change
touches and how you checked it in this PR. Write "none (checked)" only
after looking. Hub page still in the old style? Add it to issue #2218. -->

- Hub pages:
- CLI:
- Phone / Mac apps:
- Docs:
- Settings:
- Other agents' flows:

- [ ] New controls are hidden by default or the PR says why they must always show (Rule B, progressive disclosure).

## Verification

Commands run and results; include OS/Node version for installation changes:

## Evidence

<!-- Changed the dashboard, the phone or Mac apps, the TUI or voice? Drag a
screenshot or a short recording into this section (or link a
.png/.jpg/.gif/.mp4/.mov file). The ui-evidence check looks for it here.
If users see no difference, a maintainer adds the no-ui-evidence-needed
label, and this section gets one line of its own:
UI evidence: not needed because <your reason>
See CONTRIBUTING.md > UI evidence check. -->

## Docs

What changed under `docs/`, or why nothing needed to.

<!-- To skip docs for a user-facing change, a maintainer adds the
no-docs-needed label, and this section gets one line of its own:
Docs: not needed because <your reason>
See CONTRIBUTING.md > Docs gate. -->

- [ ] Every page I added or changed ends with "Check it worked" and "If something is wrong".

## Operator impact

Configuration changes, compatibility, migrations, and recovery steps (if applicable):

- [ ] No secrets, private logs, or runtime configuration included.
- [ ] Documentation updated where behavior changed.
- [ ] PR is focused; known limitations are stated honestly.
