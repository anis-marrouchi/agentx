# Desktop character concept (issue #458)

Pose sheet, version 3, and two moving previews. Not meant to be merged.

The character has no legs: its walk is the hovering (owner, 2026-10-02).

Along the edge:

![Hovering along the edge](hover-walk.gif)

Over a page, showing you a button:

![Hovering over a page](hover-guide.gif)

![Pose sheet](character-sheet.png)

Rebuild (needs `rsvg-convert` and `magick`):

    python3 build_sheet.py && rsvg-convert character-sheet.svg -o character-sheet.png
    python3 build_anim.py

`hover-*-frames.png` show every tenth frame, to check the motion as a still picture.
