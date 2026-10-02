"""Moving previews of the AgentX desktop character (issue 458).

It has no legs: its walk is the hovering. Two short loops, drawn frame by
frame with the same creature() as the pose sheet:
  hover-walk.gif   it hovers along the edge, right then left
  hover-guide.gif  it leaves the edge, floats to a button and shows it
Run: python3 build_anim.py   (needs rsvg-convert and magick)
"""
import math
import subprocess
import tempfile
from pathlib import Path

from build_sheet import BLUE, P, creature, page, trail

FPS, SECONDS, SCALE = 20, 7.0, .8


def ease(p):
    """Slow start, slow stop."""
    p = min(max(p, 0.0), 1.0)
    return p * p * (3 - 2 * p)


def span(t, a, b):
    """How far t is between a and b, 0..1."""
    return min(max((t - a) / (b - a), 0.0), 1.0)


def bob(t):
    return 4 * math.sin(2 * math.pi * t / 1.4)  # five slow bobs per loop


def blink(t, at):
    return any(0 <= t - a < .12 for a in at)


def glide(p):
    """Lean and trail strength for a glide that is p of the way: forward first, a little back at the end."""
    return 8 * math.sin(math.pi * p) + 5 * math.sin(2 * math.pi * p), math.sin(math.pi * p)


def walk(t):
    """Along the edge: wait, turn, glide right, look at you, turn, glide back."""
    x0, x1, y = 120, 600, 120
    go, back = span(t, 1.3, 3.0), span(t, 4.3, 6.0)
    x = x0 + (x1 - x0) * (ease(go) - ease(back))
    face = ease(span(t, 1.0, 1.3)) - ease(span(t, 3.0, 3.3)) - ease(span(t, 4.0, 4.3)) + ease(span(t, 6.0, 6.3))
    moving = go if 0 < go < 1 else back if 0 < back < 1 else None
    tilt, k = glide(moving) if moving is not None else (0, 0)
    lift = 16 + bob(t) + 5 * k
    d = 1 if face >= 0 else -1
    body = '<path d="M30,165 H690" stroke="#D9DEE3" stroke-width="2"/>'
    body += creature(x, y, scale=SCALE, face=face, tilt=tilt, lift=lift, sx=1 + .03 * k, sy=1 - .02 * k,
                     gaze=(2 * abs(face), 0), eyes="sleep" if blink(t, (.5, 3.6, 6.6)) else "open",
                     extra=trail(x, y - lift, d, k) if k > .05 else "")
    return page(720, 200, body)


def guide(t):
    """Over a page: leave the edge, float to the button, look at it, be glad, float back."""
    (x0, y0), (x1, y1) = (130, 300), (392, 150)
    go, back = span(t, 1.1, 2.6), span(t, 5.3, 6.6)
    p = ease(go) - ease(back)
    x, y = x0 + (x1 - x0) * p, y0 + (y1 - y0) * p
    face = ease(span(t, .8, 1.1)) - ease(span(t, 4.3, 4.6)) - ease(span(t, 5.0, 5.3)) + ease(span(t, 6.6, 6.9))
    moving = go if 0 < go < 1 else back if 0 < back < 1 else None
    tilt, k = glide(moving) if moving is not None else (0, 0)
    lift = 10 + 10 * p + bob(t) + 5 * k
    showing = 2.6 <= t < 4.3
    glad = 4.6 <= t < 5.0
    d = 1 if face >= 0 else -1
    bx, by = 480, 132
    ring = .25 + .45 * (.5 + .5 * math.sin(2 * math.pi * (t - 2.6) / .85)) if showing or glad else 0
    body = ('<rect x="20" y="20" width="680" height="350" rx="14" fill="#F7F9FB" stroke="#E3E8EE" stroke-width="1.5"/>'
            + "".join(f'<circle cx="{46+i*18}" cy="42" r="5" fill="#D9DEE3"/>' for i in range(3))
            + '<path d="M20,64 H700" stroke="#E3E8EE" stroke-width="1.5"/>'
            + "".join(f'<rect x="{rx}" y="{ry}" width="{w}" height="10" rx="5" fill="#E3E8EE"/>'
                      for rx, ry, w in [(60, 94, 280), (60, 118, 190), (60, 240, 240), (480, 94, 170), (480, 240, 150), (480, 264, 110)])
            + f'<rect x="{bx-7}" y="{by-7}" width="134" height="52" rx="14" fill="none" stroke="{BLUE}" stroke-width="2.5" opacity="{ring}"/>'
            + f'<rect x="{bx}" y="{by}" width="120" height="38" rx="9" fill="#fff" stroke="{BLUE}" stroke-width="2"/>'
            + f'<rect x="{bx+28}" y="{by+14}" width="64" height="10" rx="5" fill="{BLUE}" opacity=".7"/>')
    eyes = "happy" if glad else "wide" if .8 <= t < 1.1 else "sleep" if blink(t, (.4, 3.4)) else "open"
    body += creature(x, y, scale=SCALE, face=face, tilt=tilt, lift=lift, sx=1 + .03 * k, sy=1 - .02 * k,
                     gaze=(3 * abs(face), 1 if showing else 0), eyes=eyes,
                     extra=trail(x, y - lift, d, k) if k > .05 else "")
    return page(720, 390, body)


def render(name, scene):
    """Draw every frame, turn them into one looping GIF."""
    n = int(FPS * SECONDS)
    with tempfile.TemporaryDirectory() as tmp:
        pngs = []
        for i in range(n):
            svg, png = Path(tmp) / f"{i:03d}.svg", Path(tmp) / f"{i:03d}.png"
            svg.write_text(scene(i / FPS))
            subprocess.run(["rsvg-convert", str(svg), "-o", str(png)], check=True)
            pngs.append(str(png))
        subprocess.run(["magick", "-delay", str(100 // FPS), "-loop", "0", *pngs, "-layers", "Optimize", name], check=True)
        # every tenth frame side by side, to check the motion as a still picture
        subprocess.run(["magick", "montage", *pngs[::10], "-tile", "7x", "-geometry", "240x+2+2",
                        name.replace(".gif", "-frames.png")], check=True)
    print("wrote", name, n, "frames")


if __name__ == "__main__":
    render("hover-walk.gif", walk)
    render("hover-guide.gif", guide)
