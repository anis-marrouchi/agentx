# Desktop character concept (issue #458)

Pose sheet, version 2. Not meant to be merged.

![Pose sheet](character-sheet.png)

New in version 2: the walk is seen from the side (it looks where it is going,
right or left), and it hovers over the page to show you something.

The side walk, played as an animation:

![Side walk](walk.gif)

Rebuild: `python3 build_sheet.py`, then

    rsvg-convert character-sheet.svg -o character-sheet.png
    for i in 1 2 3 4; do rsvg-convert -z 2 walk-$i.svg -o walk-$i.png; done
    magick -delay 16 -dispose previous walk-[1-4].png -loop 0 walk.gif
