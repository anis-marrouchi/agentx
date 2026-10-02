"""Three checks of the AgentX desktop character (issue 458), as one picture.

  1. Its shape alone, in black at 32 px: the plain ball next to the ball with a tail.
  2. At the size it will live at (48 and 64 px), on a light and on a dark wallpaper.
  3. Each state with the symbols switched off: does the body alone say it?
Everything is drawn at one pixel per pixel, so the sizes are the real ones.
Run: python3 build_checks.py && rsvg-convert checks.svg -o checks.png
"""
from anim import DOZING, IDLE, LISTENING, NOTICES, UNDERSTOOD, WORKING, figure, pose
from build_sheet import R, creature, heading, page, small

W, H = 1200, 1060
out = [heading(52, "1. THE SHAPE ALONE, IN BLACK, 32 PX")]

# 1. outline only: front, turned, asleep
shapes = [("front", dict()), ("turned", dict(face=1, tilt=8)), ("asleep", dict(sx=1.14, sy=.8))]
for row, (title, tail) in enumerate([("plain ball", None), ("with a tail", 0)]):
    x0 = 150 + row * 560
    out.append(small(x0 + 130, 92, title, 600, "#111", 14))
    for i, (name, kw) in enumerate(shapes):
        lean = None if tail is None else (62 if name == "asleep" else -30 if name == "turned" else 0)
        out.append(creature(x0 + i * 130, 135 - R * .32, scale=.32, flat="#000", tail=lean, **kw))
        out.append(small(x0 + i * 130, 172, name, size=12))

# 2. real size on two wallpapers
out.append(heading(232, "2. AT ITS REAL SIZE (48 AND 64 PX), ON A LIGHT AND A DARK WALLPAPER"))
STATES = [("Idle", IDLE), ("Notices you", NOTICES), ("Listening", LISTENING), ("Working", WORKING),
          ("Understood", UNDERSTOOD), ("Dozing", DOZING), ("Moving", pose(face=1, tilt=9, lift=20))]
WALLS = [("#E9EEF5", "#C9D3E0", "#333"), ("#161B26", "#2A3242", "#C8D0DC")]
for n, (px, (bg, edge, ink)) in enumerate([(px, wall) for wall in WALLS for px in (48, 64)]):
    y0, s = 262 + n * 132, px / (2 * R)
    out.append(f'<rect x="60" y="{y0}" width="1080" height="120" rx="12" fill="{bg}"/>')
    out.append(f'<rect x="60" y="{y0+104}" width="1080" height="16" fill="{edge}"/>')  # the Dock, as a plain bar
    out.append(f'<text x="76" y="{y0+24}" font-size="12" font-weight="600" fill="{ink}">{px} px</text>')
    for i, (name, st) in enumerate(STATES):
        x = 190 + i * 140
        out.append(figure(x, y0 + 104 - R * s - 4, st, 1.0, 9, scale=s, sway=-40 if name == "Moving" else 0))
        if px == 48:  # named once per wallpaper; the larger ones reach the top of their band
            out.append(small(x, y0 + 22, name, 400, ink, 11))

# 3. symbols off
out.append(heading(852, "3. THE STATES WITH THE SYMBOLS SWITCHED OFF"))
for i, (name, st) in enumerate(STATES[:6]):
    x = 150 + i * 180
    out.append(figure(x, 940, st, 1.0, 9, scale=.8, marks=False))
    out.append(small(x, 1025, name, 600, "#111", 13))

if __name__ == "__main__":
    open("checks.svg", "w").write(page(W, H, "".join(out)))
