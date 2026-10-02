"""How the AgentX desktop character moves (issue 458).

Nothing snaps. A state is a small set of numbers (stretch, lean, height, gaze,
eyes, and how strong each mark is), so going from any state to any other is a
blend of those numbers with easing. The marks around it (trail, stars, rings,
thinking dots, sleep letters) are small particles with a short life of their own.
"""
import math

from build_sheet import P, R, creature

BASE = dict(sx=1, sy=1, tilt=0, lift=14, gx=0, gy=0, face=0, o=1, s=1, lid=0, c=0,
            hear=0, think=0, zz=0)


def pose(**kw):
    return {**BASE, **kw}


IDLE = pose()
NOTICES = pose(s=1.22, gy=-3, sx=.94, sy=1.08, lift=18)
LISTENING = pose(tilt=-9, gx=-2, gy=-1, hear=1)
WORKING = pose(lid=.5, gx=-4, gy=5, sx=1.03, sy=.96, think=1)
UNDERSTOOD = pose(o=0, c=1, sx=1.07, sy=.9, lift=8)
DROWSY = pose(lid=.55, gy=3, sx=1.04, sy=.95, lift=9)
DOZING = pose(o=0, c=-1, sx=1.14, sy=.8, lift=3, zz=1)


def ease(p):
    """Slow start, slow stop."""
    p = min(max(p, 0.0), 1.0)
    return p * p * (3 - 2 * p)


def span(t, a, b):
    """How far t is between a and b, 0..1."""
    return min(max((t - a) / (b - a), 0.0), 1.0)


def swing(p, back=1.0):
    """Like ease, with weight: a small wind-up before it goes and a small overshoot before it settles."""
    p, c = min(max(p, 0.0), 1.0), back * 1.525
    if p < .5:
        return (2 * p) ** 2 * ((c + 1) * 2 * p - c) / 2
    return ((2 * p - 2) ** 2 * ((c + 1) * (2 * p - 2) + c) + 2) / 2


EYES = ("gx", "gy", "o", "s", "lid", "c")
MARKS = ("hear", "think", "zz")


def state(t, keys):
    """The numbers at time t. keys: the first pose, then (start, pose, seconds to get there).

    The eyes go first and are there by half time; the body follows a moment later, with weight.
    """
    st = keys[0]
    for start, to, dur in keys[1:]:
        eyes, marks = ease(span(t, start, start + dur * .5)), ease(span(t, start, start + dur))
        body = swing(span(t, start + dur * .15, start + dur * 1.25))
        st = {k: st[k] + (to[k] - st[k]) * (eyes if k in EYES else marks if k in MARKS else body) for k in st}
    return st


def glide(p):
    """Lean and trail strength when p of the way: forward first, a little back at the end."""
    return 8 * math.sin(math.pi * p) + 5 * math.sin(2 * math.pi * p), math.sin(math.pi * p)


def rnd(n, salt=0):
    """The same 'random' number 0..1 for the same n, so every run draws the same frames."""
    return math.sin(n * 12.9898 + salt * 78.233) * 43758.5453 % 1


def trail(where, t, life=.8, step=.05):
    """Dots left behind while it moves: each is born at the body, drifts up, shrinks and fades.

    where(t) -> (x, y, strength, direction) of the body at that time.
    """
    out = []
    for j in range(max(int((t - life) / step) + 1, 0), int(t / step) + 1):
        a = (t - j * step) / life
        x, y, k, d = where(j * step)
        if k < .08 or not 0 <= a < 1:
            continue
        r = (2.4 + 3.6 * rnd(j)) * (1 - a) ** .8 * min(a / .12, 1)
        out.append(f'<circle cx="{x - d*(30 + 16*a)}" cy="{y + 10 + (rnd(j, 1) - .5)*26 - 16*a*rnd(j, 2)}" r="{r}" '
                   f'fill="{P[2 + j % 2]}" opacity="{.62 * (1 - a) * min(k * 1.6, 1)}"/>')
    return "".join(out)


def stars(x, y, t0, t, n=6, life=.9, seed=0):
    """A small burst of sparkles from time t0: they fly out, turn, and fade."""
    a = (t - t0) / life
    if not 0 <= a < 1:
        return ""
    out = []
    for i in range(n):
        ang = -math.pi * (.08 + .84 * (i + .5 * rnd(i, seed)) / (n - 1 + .5))  # spread over the top half
        dist = 50 + (24 + 26 * rnd(i, seed + 1)) * (1 - (1 - a) ** 3)
        r = (6 + 6 * rnd(i, seed + 2)) * math.sin(math.pi * a) ** .6
        px, py = x + math.cos(ang) * dist, y + math.sin(ang) * dist
        out.append(f'<path transform="translate({px},{py}) rotate({120*a + 40*i})" opacity="{min(2.2 * (1 - a), 1)}" '
                   f'fill="{P[1 + i % 3]}" d="M0,{-r} Q0,0 {r},0 Q0,0 0,{r} Q0,0 {-r},0 Q0,0 0,{-r} Z"/>')
    return "".join(out)


def rings(x, y, k, t):
    """Listening: the rings swell one after the other, like a voice coming in."""
    out = []
    for i in range(3):
        beat = .5 + .5 * math.sin(2 * math.pi * (1.7 * t - i * .22))
        r = 9 + i * 9 + 2 * beat
        out.append(f'<path d="M{x},{y-r} a{r},{r} 0 0 0 0,{2*r}" fill="none" stroke="{P[2]}" stroke-width="3" '
                   f'stroke-linecap="round" opacity="{k * (.85 - i*.25) * (.35 + .65*beat)}"/>')
    return "".join(out)


def thinking(x, y, k, t):
    """Working: three dots that hop in turn."""
    return "".join(
        f'<circle cx="{x+62+i*17}" cy="{y-58-i*9 - 6*max(math.sin(2*math.pi*(1.1*t - i*.2)), 0)}" r="{(4+i*1.6)*k}" '
        f'fill="{P[1]}" opacity="{k*(.45+i*.25)}"/>' for i in range(3))


def sleeping(x, y, k, t, life=2.4, step=1.2):
    """Dozing: each z rises, grows and fades."""
    out = []
    for j in range(max(int((t - life) / step) + 1, 0), int(t / step) + 1):
        a = (t - j * step) / life
        if 0 <= a < 1:
            out.append(f'<text x="{x + 50 + 24*a + 5*math.sin(5*a)}" y="{y - 26 - 40*a}" font-size="{13 + 9*a}" '
                       f'font-weight="700" fill="{P[1]}" opacity="{k * .9 * math.sin(math.pi*a)}">z</text>')
    return "".join(out)


def figure(x, y, st, t, loop, blinks=(), scale=1.0, extra="", sway=0, marks=True, tail=True):
    """The creature in state st at time t, with what keeps it alive: breath, bob, blinks and its marks.

    loop is the length of the animation, so breath and bob end where they began.
    sway: how far what it just did throws its tail back (the tail arrives late).
    """
    def wave(period):
        return math.sin(2 * math.pi * t * round(loop / period) / loop)

    z = st["zz"]
    breath = (1 - z) * .012 * wave(2.8) + z * .04 * wave(3.4)  # asleep it breathes deeper and slower
    lift = st["lift"] + (1 - z) * 4 * wave(1.4) + z * 1.5 * wave(3.4)
    shut = max([math.sin(math.pi * (t - b) / .2) for b in blinks if 0 <= t - b < .2], default=0)
    by = y + R * scale - lift - R * st["sy"] * scale  # the middle of the body
    marks = (rings(x - 78, by, st["hear"], t) + thinking(x, by + 50, st["think"], t)
             + sleeping(x, by + 10, z, t)) if marks else ""
    marks = f'<g transform="translate({x},{by}) scale({scale}) translate({-x},{-by})">{marks}</g>'  # they keep its size
    lean = sway + (1 - z) * 6 * wave(2.3) + 62 * z + 3 * z * wave(3.4)  # it sways when awake, curls over asleep
    return creature(x, y, eyes=dict(o=st["o"] * (1 - shut), s=st["s"], lid=st["lid"], c=st["c"]),
                    gaze=(st["gx"], st["gy"]), tilt=st["tilt"], sx=st["sx"] * (1 - breath / 2), sy=st["sy"] * (1 + breath),
                    lift=lift, scale=scale, face=st["face"], extra=marks + extra, tail=lean if tail else None)


def caption(x, y, t, labels, fade=.35):
    """The name of what it is doing, cross-fading. labels: (start, text)."""
    now = max(i for i, (start, _) in enumerate(labels) if start <= t)
    p = ease(span(t, labels[now][0], labels[now][0] + fade)) if now else 1
    text = '<text x="{}" y="{}" text-anchor="middle" font-size="17" font-weight="600" fill="#111" opacity="{}">{}</text>'
    return (text.format(x, y, 1 - p, labels[now - 1][1]) if now else "") + text.format(x, y, p, labels[now][1])
