# Desktop character concept (issue #458)

Pose sheet, version 3, five moving previews and a check picture. Not meant to be merged.

- The character has no legs: its walk is the hovering (owner, 2026-10-02).
- Nothing is a still picture: every state, every mark around it and every
  change between two states is animated (owner, 2026-10-02).

A state is a small set of numbers (stretch, lean, height, gaze, eyes, how
strong each mark is), so going from any state to any other is a blend of
those numbers with easing (`anim.py`). Trail dots, stars, rings, thinking
dots and the sleep letters are small particles with a short life of their own.

Proposal, not decided: a small **tail**, a tip of light on its head, so it has
a shape of its own. It arrives late when the body moves and curls over when it
sleeps. The previews show it; the pose sheet does not yet.

Motion has weight: the eyes go first, the body follows with a small wind-up
and a small overshoot, and the tail last. Next to the pointer, the eyes follow it.

| | |
|---|---|
| From state to state ![States](states.gif) | Falling asleep and waking ![Dozing](doze.gif) |

A reaction, with its stars and its trail:

![Stepping aside](step-aside.gif)

Along the edge:

![Hovering along the edge](hover-walk.gif)

Over a page, showing you a button:

![Hovering over a page](hover-guide.gif)

![Pose sheet](character-sheet.png)

Three checks, drawn at one pixel per pixel (`build_checks.py`): the shape alone
in black at 32 px, the real size on a light and a dark wallpaper, and the
states with the symbols switched off.

![Checks](checks.png)

Rebuild (needs `rsvg-convert` and `magick`):

    python3 build_sheet.py && rsvg-convert character-sheet.svg -o character-sheet.png
    python3 build_anim.py
    python3 build_checks.py && rsvg-convert checks.svg -o checks.png

`*-frames.png` show every fifth frame. `build_anim.py` also prints, for each
preview, the biggest change between two frames next to the typical one, and
the change across the loop: a pose that snapped would stand out there.
