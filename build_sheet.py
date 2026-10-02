"""Pose sheet for the AgentX desktop character (issue 458).

The character is the voice orb grown into a small creature: the same round
body in the agent's palette, two eyes, no mouth. Everything is vector, so
the app can draw it in code the way it draws the orb today.
Run: python3 build_sheet.py  ->  character-sheet.svg
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


def eye(x, y, kind, gx=0, gy=0):
    """One eye at (x, y). gx, gy move the gaze."""
    if kind == "open":
        return (f'<ellipse cx="{x+gx}" cy="{y+gy}" rx="6.5" ry="9.5" fill="{INK}"/>'
                f'<circle cx="{x+gx+2.2}" cy="{y+gy-3.4}" r="2.2" fill="#fff"/>')
    if kind == "wide":
        return (f'<ellipse cx="{x+gx}" cy="{y+gy}" rx="8" ry="11.5" fill="{INK}"/>'
                f'<circle cx="{x+gx+2.8}" cy="{y+gy-4.2}" r="2.8" fill="#fff"/>')
    if kind == "half":
        return (f'<path d="M{x+gx-6.5},{y+gy} a6.5,7 0 0 0 13,0 z" fill="{INK}"/>'
                f'<path d="M{x+gx-8},{y+gy} h16" stroke="{INK}" stroke-width="2.6" stroke-linecap="round"/>')
    if kind == "happy":
        return (f'<path d="M{x-7},{y+3} q7,-11 14,0" fill="none" stroke="{INK}" '
                f'stroke-width="3.4" stroke-linecap="round"/>')
    if kind == "sleep":
        return (f'<path d="M{x-7},{y} q7,7 14,0" fill="none" stroke="{INK}" '
                f'stroke-width="3" stroke-linecap="round"/>')
    raise ValueError(kind)


def creature(cx, cy, palette="lagoon", eyes="open", gaze=(0, 0), tilt=0, sx=1.0, sy=1.0,
             lift=0, extra="", feet=None, scale=1.0):
    """The creature standing on the ground line at cy + R."""
    ground = cy + R * scale
    shadow_w = 34 * scale * (1 - min(lift, 30) / 60)
    body_cy = -R * sy  # body sits on the ground, squash keeps the base there
    parts = [f'<ellipse cx="{cx}" cy="{ground+5}" rx="{shadow_w}" ry="{5*scale}" fill="#0F2233" opacity=".13"/>']
    parts.append(f'<g transform="translate({cx},{ground - lift}) scale({scale}) rotate({tilt})">')
    if feet:  # two small feet for the walk frames
        for fx, fy in feet:
            parts.append(f'<ellipse cx="{fx}" cy="{fy}" rx="11" ry="6" fill="{PALETTES[palette][0]}"/>')
    parts.append(f'<ellipse cx="0" cy="{body_cy}" rx="{R*sx+7}" ry="{R*sy+7}" '
                 f'fill="{PALETTES[palette][2]}" opacity=".30" filter="url(#glow)"/>')
    parts.append(f'<ellipse cx="0" cy="{body_cy}" rx="{R*sx}" ry="{R*sy}" fill="url(#g-{palette})"/>')
    parts.append(f'<ellipse cx="{-17*sx}" cy="{body_cy-24*sy}" rx="{13*sx}" ry="{8*sy}" fill="#fff" opacity=".35" '
                 f'transform="rotate(-24 {-17*sx} {body_cy-24*sy})"/>')
    ey = body_cy + 2 * sy
    gx, gy = gaze
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


W, H = 1200, 1500
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

# Walk cycle: four frames, feet alternate, body bobs and leans forward.
walk_y = 1065
walk = []
frames = [dict(feet=[(-20, -3), (16, -9)], lift=6, tilt=4, sx=.98, sy=1.02),
          dict(feet=[(-8, -5), (8, -5)], lift=11, tilt=2, sx=.96, sy=1.05),
          dict(feet=[(-16, -9), (20, -3)], lift=6, tilt=4, sx=.98, sy=1.02),
          dict(feet=[(-8, -5), (8, -5)], lift=2, tilt=1, sx=1.04, sy=.95)]
for i, f in enumerate(frames):
    x = 180 + i * 180
    walk.append(creature(x, walk_y, gaze=(4, 0), scale=.8, **f))
    walk.append(f'<text x="{x}" y="{walk_y+72}" text-anchor="middle" font-size="13" fill="#555">frame {i+1}</text>')
walk.append(f'<path d="M100,{walk_y+45} H800" stroke="#D9DEE3" stroke-width="2"/>')
walk.append(creature(1000, walk_y, gaze=(-4, 2), eyes="half", scale=.8, sx=1.02, sy=.97, tilt=-3))
walk.append(f'<text x="1000" y="{walk_y+72}" text-anchor="middle" font-size="13" fill="#555">steps aside for the pointer</text>')

# Same creature, each agent's colours.
pal_y = 1330
pals = []
for i, name in enumerate(["lagoon", "sunrise", "forest", "ocean", "dusk", "blossom"]):
    x = 150 + i * 180
    kind = ["open", "happy", "open", "wide", "half", "open"][i]
    pals.append(creature(x, pal_y, palette=name, eyes=kind, scale=.72))
    pals.append(f'<text x="{x}" y="{pal_y+68}" text-anchor="middle" font-size="14" fill="#333">{name.capitalize()}</text>')


def heading(y, text):
    return (f'<text x="60" y="{y}" font-size="15" font-weight="700" fill="#1F6FEB" letter-spacing="1.2">{text}</text>'
            f'<path d="M60,{y+10} H{W-60}" stroke="#E3E8EE" stroke-width="1.5"/>')


svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="-apple-system, 'SF Pro Text', 'Helvetica Neue', Arial, sans-serif">
<defs>{defs()}</defs>
<rect width="{W}" height="{H}" fill="#fff"/>
<text x="60" y="62" font-size="30" font-weight="700" fill="#111">AgentX desktop character: pose sheet, first example</text>
<text x="60" y="90" font-size="15" fill="#555">The orb, grown into a small creature. Same round body, the agent's own colours, two eyes, no mouth. It reacts, it never interrupts.</text>
{heading(128, "WHAT IT SHOWS")}
{''.join(cells)}
{heading(970, "MOVING AROUND WHEN IDLE")}
{''.join(walk)}
{heading(1215, "EACH AGENT KEEPS ITS OWN COLOURS")}
{''.join(pals)}
<text x="60" y="{H-28}" font-size="12" fill="#888">Example only, issue 458. Vector, drawn in code like the orb today; colours from src/voice/orb-palettes.ts.</text>
</svg>'''
open("character-sheet.svg", "w").write(svg)
print("wrote character-sheet.svg", len(svg))
