"""Pose sheet for the AgentX desktop character (issue 458), version 2.

The character is the voice orb grown into a small creature: the same round
body in the agent's palette, two eyes, no mouth. Everything is vector, so
the app can draw it in code the way it draws the orb today.
Run: python3 build_sheet.py  ->  character-sheet.svg and walk-1.svg .. walk-4.svg
"""

PALETTES = {  # from src/voice/orb-palettes.ts, deep to light
    "lagoon": ["#0B6E73", "#0E9594", "#1FBFB2", "#56DCCB", "#B8F4EA"],
    "sunrise": ["#E8505B", "#F2726F", "#F79A5A", "#FBBF4A", "#FFE3A3"],
    "forest": ["#2F5D34", "#4C7D3A", "#6FA046", "#9CC25E", "#D5EBA4"],
    "ocean": ["#15457E", "#1C6BA8", "#2B93CF", "#5DBBE8", "#BFE6FA"],
    "dusk": ["#2E2A7A", "#5B3E9E", "#8C4FB0", "#C8649E", "#F4A7B9"],
    "blossom": ["#A3245B", "#CF3F78", "#E8699A", "#F49BB8", "#FFD6E0"],
}
INK = "#0F2233"
R = 50


def defs():
    out = ['<filter id="glow" x="-60%" y="-60%" width="220%" height="220%">'
           '<feGaussianBlur stdDeviation="9"/></filter>']
    for name, c in PALETTES.items():
        out.append(
            f'<radialGradient id="g-{name}" cx="36%" cy="30%" r="78%">'
            f'<stop offset="0" stop-color="{c[4]}"/><stop offset=".28" stop-color="{c[3]}"/>'
            f'<stop offset=".58" stop-color="{c[2]}"/><stop offset=".84" stop-color="{c[1]}"/>'
            f'<stop offset="1" stop-color="{c[0]}"/></radialGradient>')
    return "".join(out)


def eye(x, y, kind, gx=0, gy=0, w=1.0):
    """One eye at (x, y). gx, gy move the gaze; w narrows the far eye in a side view."""
    if kind == "open":
        return (f'<ellipse cx="{x+gx}" cy="{y+gy}" rx="{6.5*w}" ry="9.5" fill="{INK}"/>'
                f'<circle cx="{x+gx+2.2*w}" cy="{y+gy-3.4}" r="{2.2*w}" fill="#fff"/>')
    if kind == "wide":
        return (f'<ellipse cx="{x+gx}" cy="{y+gy}" rx="{8*w}" ry="11.5" fill="{INK}"/>'
                f'<circle cx="{x+gx+2.8*w}" cy="{y+gy-4.2}" r="{2.8*w}" fill="#fff"/>')
    if kind == "half":
        return (f'<path d="M{x+gx-6.5*w},{y+gy} a{6.5*w},7 0 0 0 {13*w},0 z" fill="{INK}"/>'
                f'<path d="M{x+gx-8*w},{y+gy} h{16*w}" stroke="{INK}" stroke-width="2.6" stroke-linecap="round"/>')
    if kind == "happy":
        return (f'<path d="M{x-7*w},{y+3} q{7*w},-11 {14*w},0" fill="none" stroke="{INK}" '
                f'stroke-width="3.4" stroke-linecap="round"/>')
    if kind == "sleep":
        return (f'<path d="M{x-7*w},{y} q{7*w},7 {14*w},0" fill="none" stroke="{INK}" '
                f'stroke-width="3" stroke-linecap="round"/>')
    raise ValueError(kind)


def creature(cx, cy, palette="lagoon", eyes="open", gaze=(0, 0), tilt=0, sx=1.0, sy=1.0,
             lift=0, extra="", legs=None, scale=1.0, face=0):
    """The creature standing on the ground line at cy + R.

    face: 0 seen from the front, 1 turned to the right, -1 turned to the left.
    Turned, both eyes move to that side, the far one narrower, and the legs,
    the lean and the gaze follow.
    """
    d = face or 1
    ground = cy + R * scale
    shadow_w = 34 * scale * (1 - min(lift, 30) / 60)
    body_cy = -R * sy  # body sits on the ground, squash keeps the base there
    parts = [f'<ellipse cx="{cx}" cy="{ground+5}" rx="{shadow_w}" ry="{5*scale}" fill="#0F2233" opacity=".13"/>']
    parts.append(f'<g transform="translate({cx},{ground - lift}) scale({scale}) rotate({tilt*d})">')
    if legs:  # two short legs for the walk frames: far then near (hip x, foot x, foot height off the ground)
        gy = lift / scale  # the ground, seen from the lifted body
        parts.append(f'<g transform="scale({d},1)">')
        for n, (hx, fx, up) in enumerate(legs):  # far leg first, one stop darker
            parts.append(f'<path d="M{hx},-12 Q{hx},{gy-up-3} {fx},{gy-up-4} h8" fill="none" '
                         f'stroke="{PALETTES[palette][n]}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>')
        parts.append("</g>")
    parts.append(f'<ellipse cx="0" cy="{body_cy}" rx="{R*sx+7}" ry="{R*sy+7}" '
                 f'fill="{PALETTES[palette][2]}" opacity=".30" filter="url(#glow)"/>')
    parts.append(f'<ellipse cx="0" cy="{body_cy}" rx="{R*sx}" ry="{R*sy}" fill="url(#g-{palette})"/>')
    parts.append(f'<ellipse cx="{-17*sx}" cy="{body_cy-24*sy}" rx="{13*sx}" ry="{8*sy}" fill="#fff" opacity=".35" '
                 f'transform="rotate(-24 {-17*sx} {body_cy-24*sy})"/>')
    ey = body_cy + 2 * sy
    gx, gy = gaze
    if face:
        parts.append(eye(33 * sx * d, ey, eyes, gx * d, gy, w=.62))
        parts.append(eye(11 * sx * d, ey, eyes, gx * d, gy))
    else:
        parts.append(eye(-15 * sx, ey, eyes, gx, gy))
        parts.append(eye(15 * sx, ey, eyes, gx, gy))
    parts.append("</g>")
    parts.append(extra)
    return "".join(parts)


def arcs(x, y, side, color, n=3):
    """Sound arcs to one side (side = 1 right, -1 left)."""
    out = []
    for i in range(n):
        r = 9 + i * 9
        out.append(f'<path d="M{x},{y-r} a{r},{r} 0 0 {1 if side > 0 else 0} 0,{2*r}" fill="none" '
                   f'stroke="{color}" stroke-width="3" stroke-linecap="round" opacity="{.85 - i*.25}"/>')
    return "".join(out)


def label(x, y, title, sub):
    return (f'<text x="{x}" y="{y}" text-anchor="middle" font-size="17" font-weight="600" fill="#111">{title}</text>'
            f'<text x="{x}" y="{y+21}" text-anchor="middle" font-size="13" fill="#555">{sub}</text>')


W, H = 1200, 1945
P = PALETTES["lagoon"]
col = [200, 600, 1000]
rows = [215, 485, 755]
cells = []


def cell(i, title, sub, **kw):
    x, y = col[i % 3], rows[i // 3]
    extra = kw.pop("extra_fn", None)
    cells.append(creature(x, y, extra=extra(x, y) if extra else "", **kw) + label(x, y + 100, title, sub))


cell(0, "Idle", "breathes slowly, blinks now and then")
cell(1, "Notices you", "you start talking: it stretches up and looks at you",
     eyes="wide", gaze=(0, -3), sx=.94, sy=1.08)
cell(2, "Listening", "leans in; the rings follow your voice", tilt=-9, gaze=(-2, -1),
     extra_fn=lambda x, y: arcs(x - 78, y - 6, -1, P[2]))
cell(3, "Working", "looks down at its work, eyes half closed", eyes="half", gaze=(-4, 5), sx=1.03, sy=.96,
     extra_fn=lambda x, y: "".join(
         f'<circle cx="{x+62+i*17}" cy="{y-58-i*9}" r="{4+i*1.6}" fill="{P[1]}" opacity="{.45+i*.25}"/>' for i in range(3)))
cell(4, "Speaking", "a small bounce with each sentence", lift=10, gaze=(0, -1), sx=.97, sy=1.04,
     extra_fn=lambda x, y: arcs(x + 74, y - 14, 1, P[2]))
cell(5, "Understood", "a nod: eyes smile, body dips", eyes="happy", sx=1.07, sy=.9)
cell(6, "Dozing", "idle for a while: settles and sleeps", eyes="sleep", sx=1.14, sy=.8,
     extra_fn=lambda x, y: (f'<text x="{x+56}" y="{y-32}" font-size="20" font-weight="700" fill="{P[1]}" opacity=".9">z</text>'
                            f'<text x="{x+72}" y="{y-52}" font-size="15" font-weight="700" fill="{P[1]}" opacity=".6">z</text>'))
cell(7, "An agent is calling", "hops and rings on both sides", eyes="wide", lift=20, sx=.95, sy=1.06,
     extra_fn=lambda x, y: arcs(x + 76, y - 26, 1, P[1], 2) + arcs(x - 76, y - 26, -1, P[1], 2))
cell(8, "Needs your answer", "tilts its head and waits, never interrupts", tilt=11, gaze=(3, -3),
     extra_fn=lambda x, y: (f'<circle cx="{x+62}" cy="{y-62}" r="15" fill="#fff" stroke="{P[0]}" stroke-width="2.5"/>'
                            f'<text x="{x+62}" y="{y-55}" text-anchor="middle" font-size="20" font-weight="700" fill="{P[0]}">?</text>'))

# Walk cycle, seen from the side: four frames, legs alternate, body bobs and leans forward.
walk_y = 1058
walk = []
frames = [dict(legs=[(-6, -32, 0), (7, 24, 0)], lift=12, tilt=4, sx=.98, sy=1.02),
          dict(legs=[(-6, 2, 9), (7, 4, 0)], lift=17, tilt=2, sx=.96, sy=1.05),
          dict(legs=[(-6, 24, 0), (7, -32, 0)], lift=12, tilt=4, sx=.98, sy=1.02),
          dict(legs=[(-6, 4, 0), (7, 2, 9)], lift=17, tilt=2, sx=.96, sy=1.05)]


def small(x, y, text, weight=400, fill="#555", size=13):
    return f'<text x="{x}" y="{y}" text-anchor="middle" font-size="{size}" font-weight="{weight}" fill="{fill}">{text}</text>'


for i, f in enumerate(frames):
    x = 140 + i * 160
    walk.append(creature(x, walk_y, gaze=(2, 0), scale=.8, face=1, **f))
    walk.append(small(x, walk_y + 72, ["stride", "pass", "stride", "pass"][i]))
walk.append(creature(790, walk_y, gaze=(-5, 0), scale=.8, sx=1.03, sy=.97))
walk.append(small(790, walk_y + 72, "stops, looks back"))
for i, f in enumerate(frames[:2]):
    x = 950 + i * 140
    walk.append(creature(x, walk_y, gaze=(2, 0), scale=.8, face=-1, **f))
    walk.append(small(x, walk_y + 72, ["stride", "pass"][i]))
walk.append(f'<path d="M70,{walk_y+45} H1130" stroke="#D9DEE3" stroke-width="2"/>')
walk.append(small(380, walk_y + 96, "walks right, looking right &#8594;", 600, "#111", 14))
walk.append(small(1020, walk_y + 96, "&#8592; walks left, looking left", 600, "#111", 14))
walk.append(f'<text x="60" y="{walk_y+128}" font-size="13" fill="#555">It looks where it is going. '
            f'Which edge it walks along is to confirm with the owner (the word was unclear; most likely the Dock).</text>')

# Hovering over the page: it leaves the edge, floats to something and shows it.
hov_y, BLUE = 1272, "#1F6FEB"
py = hov_y + 196  # the line the hovering poses are set on
hov = [f'<rect x="60" y="{hov_y}" width="1080" height="330" rx="14" fill="#F7F9FB" stroke="#E3E8EE" stroke-width="1.5"/>']
hov += [f'<circle cx="{86+i*18}" cy="{hov_y+22}" r="5" fill="#D9DEE3"/>' for i in range(3)]
hov.append(f'<path d="M60,{hov_y+44} H1140" stroke="#E3E8EE" stroke-width="1.5"/>')
for x, y, w in [(100, 74, 300), (100, 98, 210), (470, 74, 250), (860, 74, 220), (860, 98, 150)]:  # page text, as grey bars
    hov.append(f'<rect x="{x}" y="{hov_y+y}" width="{w}" height="10" rx="5" fill="#E3E8EE"/>')
bx, by = 668, py - 58  # the thing it shows: a button on the page
hov.append(f'<rect x="{bx-7}" y="{by-7}" width="134" height="52" rx="14" fill="none" stroke="{BLUE}" stroke-width="2.5" opacity=".55"/>')
hov.append(f'<rect x="{bx}" y="{by}" width="120" height="38" rx="9" fill="#fff" stroke="{BLUE}" stroke-width="2"/>')
hov.append(f'<rect x="{bx+28}" y="{by+14}" width="64" height="10" rx="5" fill="{BLUE}" opacity=".7"/>')


def trail(x, y, d=1):
    return "".join(f'<circle cx="{x-d*(58+i*20)}" cy="{y+22+i*9}" r="{6-i*1.6}" fill="{P[2]}" opacity="{.5-i*.14}"/>'
                   for i in range(3))


def pointer(x, y):
    return (f'<path transform="translate({x},{y}) scale(1.5)" d="M0,0 V17 L4.5,13 L7.5,20 L10,19 L7,12 H13 Z" '
            f'fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>')


def sparks(x, y):
    return "".join(f'<path d="M{x+dx},{y+dy-s} v{2*s} M{x+dx-s},{y+dy} h{2*s}" stroke="{P[1]}" stroke-width="2.6" '
                   f'stroke-linecap="round"/>' for dx, dy, s in [(52, -52, 7), (70, -26, 4.5), (-56, -44, 5)])


steps = [
    (170, "Lifts off the edge", "leaves the edge, no legs", dict(lift=16, eyes="wide", gaze=(3, -4), sx=.96, sy=1.05)),
    (375, "Floats across the page", "leans the way it is going", dict(lift=30, face=1, tilt=9, gaze=(2, -1), extra_fn=lambda x, y: trail(x, y - 30))),
    (575, "Shows you the thing", "stops beside it and looks at it", dict(lift=24, face=1, tilt=5, gaze=(3, 1))),
    (868, "Reacts", "how is still to decide", dict(lift=22, eyes="happy", sx=1.04, sy=.95, extra_fn=lambda x, y: sparks(x, y - 22))),
    (1050, "Steps aside", "gets out of the pointer's way", dict(lift=20, eyes="half", gaze=(-4, 2), tilt=6, sx=1.02, sy=.97,
                                                         extra_fn=lambda x, y: pointer(x - 78, y - 52))),
]
for x, title, sub, kw in steps:
    extra = kw.pop("extra_fn", None)
    hov.append(creature(x, py, scale=.8, extra=extra(x, py) if extra else "", **kw))
    hov.append(small(x, py + 72, title, 600, "#111", 14))
    hov.append(small(x, py + 91, sub, size=12.5))

# Same creature, each agent's colours.
pal_y = 1775
pals = []
for i, name in enumerate(["lagoon", "sunrise", "forest", "ocean", "dusk", "blossom"]):
    x = 150 + i * 180
    kind = ["open", "happy", "open", "wide", "half", "open"][i]
    pals.append(creature(x, pal_y, palette=name, eyes=kind, scale=.72))
    pals.append(f'<text x="{x}" y="{pal_y+68}" text-anchor="middle" font-size="14" fill="#333">{name.capitalize()}</text>')


def heading(y, text):
    return (f'<text x="60" y="{y}" font-size="15" font-weight="700" fill="#1F6FEB" letter-spacing="1.2">{text}</text>'
            f'<path d="M60,{y+10} H{W-60}" stroke="#E3E8EE" stroke-width="1.5"/>')


def page(w, h, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" '
            f'font-family="-apple-system, \'SF Pro Text\', \'Helvetica Neue\', Arial, sans-serif">'
            f'<defs>{defs()}</defs><rect width="{w}" height="{h}" fill="#fff"/>{body}</svg>')


svg = page(W, H, f'''
<text x="60" y="62" font-size="30" font-weight="700" fill="#111">AgentX desktop character: pose sheet, version 2</text>
<text x="60" y="90" font-size="15" fill="#555">The orb, grown into a small creature. Same round body, the agent's own colours, two eyes, no mouth. It reacts, it never interrupts.</text>
{heading(128, "WHAT IT SHOWS")}
{''.join(cells)}
{heading(970, "WALKING ALONG THE EDGE, SEEN FROM THE SIDE")}
{''.join(walk)}
{heading(1240, "HOVERING OVER THE PAGE, GUIDING YOU")}
{''.join(hov)}
{heading(1660, "EACH AGENT KEEPS ITS OWN COLOURS")}
{''.join(pals)}
<text x="60" y="{H-28}" font-size="12" fill="#888">Example only, issue 458. Vector, drawn in code like the orb today; colours from src/voice/orb-palettes.ts.</text>
''')
open("character-sheet.svg", "w").write(svg)
print("wrote character-sheet.svg", len(svg))

# The four walk frames alone, to play as an animation (see README).
for i, f in enumerate(frames):
    body = creature(110, 105, gaze=(2, 0), face=1, **f) + '<path d="M0,160 H220" stroke="#D9DEE3" stroke-width="2"/>'
    open(f"walk-{i+1}.svg", "w").write(page(220, 190, body))
