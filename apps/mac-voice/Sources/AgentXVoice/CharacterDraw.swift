import AppKit

/// One frame of the character, drawn in code like the orb: one drawing,
/// every palette. The context is flipped (y grows downwards) and scaled so
/// the body is 100 across, with the origin on the edge under the character.
enum CharacterDraw {
    typealias Frame = CharacterSim.Frame

    private static let ink = NSColor(srgbRed: 0.059, green: 0.133, blue: 0.2, alpha: 1)
    private static let radius: CGFloat = 50

    /// Five stops, deep to light: the agent's palette, or shades of `tint`
    /// without one (an error, held notifications, an older daemon).
    static func stops(tint: NSColor, colors: [NSColor]?) -> [NSColor] {
        if let colors, colors.count == 5 { return colors }
        let base = tint.usingColorSpace(.sRGB) ?? tint
        return [base.blended(withFraction: 0.45, of: .black), base.blended(withFraction: 0.2, of: .black), base,
                base.blended(withFraction: 0.35, of: .white), base.blended(withFraction: 0.7, of: .white)].map { $0 ?? base }
    }

    /// Draw `frame`. `edge` is the point under the character and `unit`
    /// the points per drawing unit; the marks are placed from `origin`,
    /// the screen position of the context's left edge.
    static func draw(_ frame: Frame, in ctx: CGContext, edge: CGPoint, origin: CGFloat, unit: CGFloat, stops c: [NSColor]) {
        let pose = frame.pose
        let sx = CGFloat(pose.sx), sy = CGFloat(pose.sy), lift = CGFloat(pose.lift)
        let turned = CGFloat(abs(frame.face)), way: CGFloat = frame.face >= 0 ? 1 : -1

        // Trail dots and stars stay where they were left, on the screen.
        for m in frame.dots + frame.stars {
            ctx.saveGState()
            ctx.translateBy(x: CGFloat(m.x) - origin, y: edge.y - CGFloat(m.y))
            ctx.scaleBy(x: unit, y: unit)
            ctx.setFillColor(c[m.shade].withAlphaComponent(CGFloat(m.alpha)).cgColor)
            let r = CGFloat(m.r)
            if m.turn == 0 {
                ctx.fillEllipse(in: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r))
            } else {
                ctx.rotate(by: CGFloat(m.turn) * .pi / 180)
                let star = CGMutablePath()
                star.move(to: CGPoint(x: 0, y: -r))
                for p in [CGPoint(x: r, y: 0), CGPoint(x: 0, y: r), CGPoint(x: -r, y: 0), CGPoint(x: 0, y: -r)] {
                    star.addQuadCurve(to: p, control: .zero)
                }
                ctx.addPath(star)
                ctx.fillPath()
            }
            ctx.restoreGState()
        }

        ctx.saveGState()
        ctx.translateBy(x: edge.x, y: edge.y)
        ctx.scaleBy(x: unit, y: unit)

        // Its shadow on the edge, smaller the higher it hovers.
        let shadow = 34 * (1 - min(lift, 30) / 60)
        ctx.setFillColor(ink.withAlphaComponent(0.13).cgColor)
        ctx.fillEllipse(in: CGRect(x: -shadow, y: 0, width: 2 * shadow, height: 10))

        let middle = -lift - radius * sy
        marks(frame, in: ctx, middle: middle, stops: c)

        ctx.translateBy(x: 0, y: -lift)
        ctx.rotate(by: CGFloat(pose.tilt) * .pi / 180)
        let cy = -radius * sy

        // The body: a soft glow, the palette from light (top left) to
        // deep, a rim so it reads on a pale wallpaper, and a highlight.
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        ctx.saveGState()
        ctx.translateBy(x: 0, y: cy)
        ctx.scaleBy(x: sx, y: sy)
        let glow = CGGradient(colorsSpace: space, colors: [c[2].withAlphaComponent(0.34).cgColor, c[2].withAlphaComponent(0).cgColor] as CFArray,
                              locations: [0.6, 1])!
        ctx.drawRadialGradient(glow, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: radius + 20, options: [])
        let body = CGRect(x: -radius, y: -radius, width: 2 * radius, height: 2 * radius)
        ctx.saveGState()
        ctx.addEllipse(in: body)
        ctx.clip()
        let fill = CGGradient(colorsSpace: space, colors: [c[4], c[3], c[2], c[1], c[0]].map(\.cgColor) as CFArray,
                              locations: [0, 0.28, 0.58, 0.84, 1])!
        let light = CGPoint(x: -14, y: -20)
        ctx.drawRadialGradient(fill, startCenter: light, startRadius: 0, endCenter: light, endRadius: 78,
                               options: [.drawsAfterEndLocation])
        ctx.restoreGState()
        ctx.setStrokeColor(c[0].withAlphaComponent(0.4).cgColor)
        ctx.setLineWidth(1.5)
        ctx.strokeEllipse(in: body.insetBy(dx: 0.75, dy: 0.75))
        ctx.translateBy(x: -17, y: -24)
        ctx.rotate(by: -24 * .pi / 180)
        ctx.setFillColor(NSColor.white.withAlphaComponent(0.35).cgColor)
        ctx.fillEllipse(in: CGRect(x: -13, y: -8, width: 26, height: 16))
        ctx.restoreGState()

        // Turned, both eyes move to that side and the far one narrows.
        let ey = cy + 2 * sy
        let gaze = CGPoint(x: CGFloat(pose.gx), y: CGFloat(pose.gy))
        eye(in: ctx, at: CGPoint(x: (15 + 18 * turned) * sx * way, y: ey), pose, gaze: gaze, width: 1 - 0.38 * turned)
        eye(in: ctx, at: CGPoint(x: (-15 + 26 * turned) * sx * way, y: ey), pose, gaze: gaze, width: 1)
        ctx.restoreGState()
    }

    /// One eye. As it closes, the eyeball fades into the curve of the shut
    /// eye, so one look turns into another without a jump.
    private static func eye(in ctx: CGContext, at p: CGPoint, _ pose: CharacterMath.Pose, gaze: CGPoint, width w: CGFloat) {
        let open = CGFloat(pose.open), s = CGFloat(pose.size), lid = CGFloat(pose.lid), curve = CGFloat(pose.curve)
        let k = min(max(open, 0) / 0.3, 1)
        if k > 0 {
            let c = CGPoint(x: p.x + gaze.x, y: p.y + gaze.y)
            let rx = 6.5 * s * w, ry = 9.5 * s * max(open, 0.04)
            let top = c.y - ry + 2 * ry * lid  // what shows below the eyelid
            ctx.saveGState()
            ctx.clip(to: CGRect(x: c.x - rx - 1, y: top, width: 2 * rx + 2, height: 2 * ry + 1))
            ctx.setFillColor(ink.withAlphaComponent(k).cgColor)
            ctx.fillEllipse(in: CGRect(x: c.x - rx, y: c.y - ry, width: 2 * rx, height: 2 * ry))
            ctx.restoreGState()
            if lid > 0.02 {
                let half = rx * max(1 - pow((top - c.y) / ry, 2), 0).squareRoot() + 1.5 * w
                line(in: ctx, [CGPoint(x: c.x - half, y: top), CGPoint(x: c.x + half, y: top)],
                     ink.withAlphaComponent(k * min(lid * 4, 1)), width: 2.6)
            }
            let shine = k * max(1 - lid * 2.5, 0) * min(max(open * 2 - 0.6, 0), 1)
            ctx.setFillColor(NSColor.white.withAlphaComponent(shine).cgColor)
            let r = 2.2 * s * w
            ctx.fillEllipse(in: CGRect(x: c.x, y: c.y - 3.4 * s * open - r, width: 2 * r, height: 2 * r))
        }
        if k < 1 {
            let shut = CGMutablePath()
            shut.move(to: CGPoint(x: p.x - 7 * w, y: p.y + 1.5 + 1.5 * curve))
            shut.addQuadCurve(to: CGPoint(x: p.x + 7 * w, y: p.y + 1.5 + 1.5 * curve),
                              control: CGPoint(x: p.x, y: p.y - 0.5 - 7.5 * curve))
            ctx.addPath(shut)
            ctx.setStrokeColor(ink.withAlphaComponent(1 - k).cgColor)
            ctx.setLineWidth(3.2)
            ctx.setLineCap(.round)
            ctx.strokePath()
        }
    }

    /// The marks beside it, each with a loop of its own: voice rings, the
    /// arcs of its own voice, thinking dots, sleep letters, call rings and
    /// the question. `middle` is the height of the middle of its body.
    private static func marks(_ frame: Frame, in ctx: CGContext, middle: CGFloat, stops c: [NSColor]) {
        let pose = frame.pose, t = frame.t
        func beat(_ rate: Double, _ i: Int) -> CGFloat { CGFloat(0.5 + 0.5 * sin(2 * .pi * (rate * t - Double(i) * 0.22))) }
        /// Arcs opening away from the body on `side`, swelling one after the other.
        func arcs(_ n: Int, side: CGFloat, x: CGFloat, y: CGFloat, strength: CGFloat, rate: Double, _ color: NSColor) {
            guard strength > 0.01 else { return }
            for i in 0..<n {
                let b = beat(rate, i), r = 9 + CGFloat(i) * 9 + 2 * b
                let arc = CGMutablePath()
                arc.addArc(center: CGPoint(x: x, y: y), radius: r, startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: side < 0)
                ctx.addPath(arc)
                ctx.setStrokeColor(color.withAlphaComponent(strength * (0.85 - CGFloat(i) * 0.25) * (0.35 + 0.65 * b)).cgColor)
                ctx.setLineWidth(3)
                ctx.setLineCap(.round)
                ctx.strokePath()
            }
        }
        // Listening: the rings follow your voice.
        arcs(3, side: -1, x: -78, y: middle, strength: CGFloat(pose.hear * (0.45 + 0.55 * frame.level)), rate: 1.7, c[2])
        // Speaking: its own voice goes out the other way.
        arcs(3, side: 1, x: 74, y: middle - 8, strength: CGFloat(pose.speak * OrbMath.speakingEnvelope(at: t)), rate: 2.1, c[2])
        // An agent is calling: it rings on both sides.
        arcs(2, side: 1, x: 76, y: middle - 20, strength: CGFloat(pose.ring), rate: 2.4, c[1])
        arcs(2, side: -1, x: -76, y: middle - 20, strength: CGFloat(pose.ring), rate: 2.4, c[1])

        // Working: three dots that hop in turn.
        let think = CGFloat(pose.think)
        if think > 0.01 {
            for i in 0..<3 {
                let hop = CGFloat(max(sin(2 * .pi * (1.1 * t - Double(i) * 0.2)), 0)), r = (4 + CGFloat(i) * 1.6) * think
                ctx.setFillColor(c[1].withAlphaComponent(think * (0.45 + CGFloat(i) * 0.25)).cgColor)
                ctx.fillEllipse(in: CGRect(x: 62 + CGFloat(i) * 17 - r, y: middle - 8 - CGFloat(i) * 9 - 6 * hop - r, width: 2 * r, height: 2 * r))
            }
        }

        // Dozing: each z rises, grows and fades.
        if pose.sleep > 0.01 {
            let life = 2.4, every = 1.2
            for j in max(Int(((t - life) / every).rounded(.down)) + 1, 0)...Int((t / every).rounded(.down)) {
                let a = (t - Double(j) * every) / life
                guard a >= 0, a < 1 else { continue }
                text("z", in: ctx, at: CGPoint(x: 50 + 24 * a + 5 * sin(5 * a), y: Double(middle) - 16 - 40 * a),
                     size: 13 + 9 * a, c[1].withAlphaComponent(CGFloat(pose.sleep * 0.9 * sin(.pi * a))))
            }
        }

        // Needs your answer: a question that grows out of it and waits.
        let ask = CGFloat(pose.ask)
        if ask > 0.01 {
            let r = 15 * ask, bob = CGFloat(2 * sin(2 * .pi * t / 1.8))
            let at = CGPoint(x: 64, y: middle - 44 - bob)
            let bubble = CGRect(x: at.x - r, y: at.y - r, width: 2 * r, height: 2 * r)
            ctx.setFillColor(NSColor.white.withAlphaComponent(ask).cgColor)
            ctx.fillEllipse(in: bubble)
            ctx.setStrokeColor(c[0].withAlphaComponent(ask).cgColor)
            ctx.setLineWidth(2.5)
            ctx.strokeEllipse(in: bubble)
            text("?", in: ctx, at: CGPoint(x: at.x - 5.5 * ask, y: at.y - 12 * ask), size: Double(20 * ask), c[0].withAlphaComponent(ask))
        }
    }

    private static func line(in ctx: CGContext, _ points: [CGPoint], _ color: NSColor, width: CGFloat) {
        ctx.setStrokeColor(color.cgColor)
        ctx.setLineWidth(width)
        ctx.setLineCap(.round)
        ctx.strokeLineSegments(between: points)
    }

    /// Bold text with its top-left corner at `at`.
    private static func text(_ s: String, in ctx: CGContext, at: CGPoint, size: Double, _ color: NSColor) {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
        (s as NSString).draw(at: at, withAttributes: [.font: NSFont.systemFont(ofSize: size, weight: .bold), .foregroundColor: color])
        NSGraphicsContext.restoreGraphicsState()
    }
}
