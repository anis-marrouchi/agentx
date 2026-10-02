"""Moving previews of the AgentX desktop character (issue 458).

It has no legs: its walk is the hovering. Nothing is a still picture: every
state, every mark and every change between two states is animated (anim.py).
  states.gif       idle, notices you, listening, working, understood, idle
  doze.gif         gets sleepy, dozes, wakes
  step-aside.gif   the pointer comes close: it reacts and steps aside
  hover-walk.gif   it hovers along the edge, right then left
  hover-guide.gif  it leaves the edge, floats to a button and shows it
Run: python3 build_anim.py [name ...]   (needs rsvg-convert and magick)
"""
import math
import subprocess
import sys
import tempfile
from pathlib import Path

from anim import (DOZING, DROWSY, IDLE, LISTENING, NOTICES, UNDERSTOOD, WORKING, caption, ease, figure, glide, pose,
                  span, stars, state, swing, trail)
from build_sheet import BLUE, R, page, pointer

FPS, S = 20, .8  # frames a second; the size it is drawn at when it moves about


def late(t, keys, by=.16):
    """How far the tail is thrown by what the body did a moment ago: it arrives late."""
    then, now = state(t - by, keys), state(t, keys)
    return 1.6 * (then["tilt"] - now["tilt"]) + 90 * (now["sy"] - then["sy"])


def states(t):
    keys = [IDLE, (1.0, NOTICES, .35), (2.2, LISTENING, .5), (4.0, WORKING, .6), (6.0, UNDERSTOOD, .35), (7.3, IDLE, .6)]
    names = [(0, "Idle"), (1.0, "Notices you"), (2.2, "Listening"), (4.0, "Working"), (6.0, "Understood"), (7.3, "Idle")]
    body = figure(210, 150, state(t, keys), t, 9, blinks=(.5, 3.2, 8.3), extra=stars(210, 150, 6.1, t), sway=late(t, keys))
    return page(420, 320, body + caption(210, 285, t, names))


def doze(t):
    keys = [IDLE, (1.2, DROWSY, 1.0), (2.9, DOZING, 1.2), (7.4, NOTICES, .4), (8.3, IDLE, .7)]
    names = [(0, "Idle for a while"), (1.2, "Gets sleepy"), (2.9, "Dozing"), (7.4, "You speak: it wakes"), (8.3, "Idle for a while")]
    body = figure(210, 150, state(t, keys), t, 10, blinks=(.6, 9.4), sway=late(t, keys))
    return page(420, 320, body + caption(210, 285, t, names))


def mover(t, a, b, legs, turns):
    """Where it is and how it leans. legs: (start, end, +1 out or -1 back); turns: (start, end, change of face)."""
    p = sum(way * swing(span(t, t0, t1), .7) for t0, t1, way in legs)
    face = sum(by * ease(span(t, t0, t1)) for t0, t1, by in turns)
    tilt, k = next((glide(span(t, t0, t1)) for t0, t1, _ in legs if t0 < t < t1), (0, 0))
    back = next((glide(span(t - .14, t0, t1))[1] for t0, t1, _ in legs if t0 < t - .14 < t1), 0)  # the tail, a moment behind
    return a[0] + (b[0] - a[0]) * p, a[1] + (b[1] - a[1]) * p, p, face, tilt, k, back


def moving(t, st, x, y, face, tilt, k, back, loop, where, **kw):
    """The figure while it travels: lean, stretch and its trail."""
    st = {**st, "face": face, "tilt": st["tilt"] + tilt, "lift": st["lift"] + 5 * k, "sx": st["sx"] + .03 * k, "sy": st["sy"] - .02 * k}
    return trail(where, t) + figure(x, y, st, t, loop, scale=S, sway=-48 * back, **kw)


def walk(t):
    def at(t):
        return mover(t, (120, 120), (600, 120), [(1.3, 3.0, 1), (4.3, 6.0, -1)],
                     [(1.0, 1.3, 1), (3.0, 3.3, -1), (4.0, 4.3, -1), (6.0, 6.3, 1)])

    def where(t):
        x, y, _, face, _, k, _ = at(t)
        return x, y + R * S - 16 - R * S, k, 1 if face >= 0 else -1

    x, y, _, face, tilt, k, back = at(t)
    body = '<path d="M30,165 H690" stroke="#D9DEE3" stroke-width="2"/>'
    body += moving(t, pose(lift=16, gx=2 * abs(face)), x, y, face, tilt, k, back, 7, where, blinks=(.5, 3.6, 6.6))
    return page(720, 200, body)


def aside(t):
    """The pointer comes close: it is startled, steps aside, watches, and comes back when the pointer has gone."""
    def at(t):
        return mover(t, (330, 120), (520, 120), [(1.3, 2.0, 1), (4.9, 5.7, -1)],
                     [(1.25, 1.45, 1), (1.9, 2.15, -1), (4.75, 4.95, -1), (5.6, 5.85, 1)])

    def where(t):
        x, y, _, face, _, k, _ = at(t)
        return x, y + R * S - 16 - R * S, k, 1 if face >= 0 else -1

    x, y, _, face, tilt, k, back = at(t)
    keys = [pose(lift=16), (1.05, pose(s=1.22, gx=-4, gy=-1, sx=.95, sy=1.06, lift=22), .2),
            (2.1, pose(lift=16, gx=-4, gy=1, lid=.15), .4), (4.5, pose(lift=16), .4)]
    names = [(0, "Idle"), (.3, "The pointer comes close"), (1.05, "It steps aside"), (2.2, "It waits"), (4.7, "It comes back"), (6.0, "Idle")]
    come, go = ease(span(t, .2, 1.7)), ease(span(t, 3.4, 4.6))
    px, py = 90 + 180 * come - 150 * go, 20 + 85 * come + 130 * go
    show = ease(span(t, .1, .4)) * (1 - ease(span(t, 4.2, 4.6)))
    body = '<path d="M30,165 H690" stroke="#D9DEE3" stroke-width="2"/>'
    st = state(t, keys)
    seen = show * (1 - ease(span(t, 1.3, 1.5)) + ease(span(t, 2.0, 2.2)))  # not while it turns away to go
    st["gx"] += seen * (max(min((px - x) / 20, 5), -5) - st["gx"])
    st["gy"] += seen * (max(min((py - 95) / 22, 4), -4) - st["gy"])
    body += moving(t, st, x, y, face, tilt, k, back, 7, where, blinks=(.5, 3.0, 6.5), extra=stars(330, 105, 1.1, t, seed=3))
    body += f'<g opacity="{show}">{pointer(px, py)}</g>' + caption(360, 205, t, names)
    return page(720, 225, body)


def guide(t):
    """Over a page: leave the edge, float to the button, look at it, be glad, float back."""
    def at(t):
        return mover(t, (130, 300), (392, 150), [(1.1, 2.6, 1), (5.3, 6.6, -1)],
                     [(.8, 1.1, 1), (4.3, 4.6, -1), (5.0, 5.3, -1), (6.6, 6.9, 1)])

    def where(t):
        x, y, p, face, _, k, _ = at(t)
        return x, y + R * S - (10 + 10 * p) - R * S, k, 1 if face >= 0 else -1

    x, y, p, face, tilt, k, back = at(t)
    keys = [pose(lift=10), (.75, pose(lift=14, s=1.2), .2), (1.2, pose(lift=20, gx=3), 1.4),
            (2.6, pose(lift=20, gx=3, gy=1), .3), (4.55, pose(lift=18, o=0, c=1, sx=1.05, sy=.94), .25), (5.1, pose(lift=10), 1.5)]
    bx, by = 480, 132
    shown = ease(span(t, 2.6, 2.9)) * (1 - ease(span(t, 5.0, 5.4)))
    ring = shown * (.3 + .5 * (.5 + .5 * math.sin(2 * math.pi * (t - 2.6) / .85)))
    body = ('<rect x="20" y="20" width="680" height="350" rx="14" fill="#F7F9FB" stroke="#E3E8EE" stroke-width="1.5"/>'
            + "".join(f'<circle cx="{46+i*18}" cy="42" r="5" fill="#D9DEE3"/>' for i in range(3))
            + '<path d="M20,64 H700" stroke="#E3E8EE" stroke-width="1.5"/>'
            + "".join(f'<rect x="{rx}" y="{ry}" width="{w}" height="10" rx="5" fill="#E3E8EE"/>'
                      for rx, ry, w in [(60, 94, 280), (60, 118, 190), (60, 240, 240), (480, 94, 170), (480, 240, 150), (480, 264, 110)])
            + f'<rect x="{bx-7-3*shown}" y="{by-7-3*shown}" width="{134+6*shown}" height="{52+6*shown}" rx="15" fill="none" '
              f'stroke="{BLUE}" stroke-width="2.5" opacity="{ring}"/>'
            + f'<rect x="{bx}" y="{by}" width="120" height="38" rx="9" fill="#fff" stroke="{BLUE}" stroke-width="2"/>'
            + f'<rect x="{bx+28}" y="{by+14}" width="64" height="10" rx="5" fill="{BLUE}" opacity=".7"/>')
    body += moving(t, state(t, keys), x, y, face, tilt, k, back, 7, where, blinks=(.4, 3.4), extra=stars(392, 128, 4.6, t, seed=5))
    return page(720, 390, body)


SCENES = {"states": (states, 9), "doze": (doze, 10), "step-aside": (aside, 7), "hover-walk": (walk, 7), "hover-guide": (guide, 7)}


def render(name, scene, seconds):
    """Draw every frame, make one looping GIF, a strip of stills, and measure how much each frame differs from the last."""
    n = int(FPS * seconds)
    with tempfile.TemporaryDirectory() as tmp:
        pngs = []
        for i in range(n):
            svg, png = Path(tmp) / f"{i:03d}.svg", Path(tmp) / f"{i:03d}.png"
            svg.write_text(scene(i / FPS))
            subprocess.run(["rsvg-convert", str(svg), "-o", str(png)], check=True)
            pngs.append(str(png))
        subprocess.run(["magick", "-delay", str(100 // FPS), "-loop", "0", *pngs, "-layers", "Optimize", f"{name}.gif"], check=True)
        subprocess.run(["magick", "montage", *pngs[::5], "-tile", "9x", "-geometry", "200x+2+2", f"{name}-frames.png"], check=True)
        # a pose that snapped would show as one frame far more different from the one before than the rest
        jumps = []
        for i in range(n):  # the last frame is compared with the first: the loop must not jump either
            out = subprocess.run(["magick", "compare", "-metric", "RMSE", pngs[i - 1], pngs[i], "null:"],
                                 capture_output=True, text=True).stderr
            jumps.append(float(out.split("(")[1].rstrip(")")))
    worst = max(range(n), key=jumps.__getitem__)
    print(f"{name}.gif: {n} frames; biggest change between two frames {jumps[worst]:.4f} at {worst / FPS:.2f}s, "
          f"typical {sorted(jumps)[n // 2]:.4f}, across the loop {jumps[0]:.4f}")


if __name__ == "__main__":
    for name in sys.argv[1:] or SCENES:
        render(name, *SCENES[name])
