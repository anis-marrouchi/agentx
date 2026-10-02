import AppKit

/// The pill's background, drawn the way macOS draws its own floating
/// surfaces: popover vibrancy, a continuous-corner shape, a hairline
/// border, and the window's soft shadow around it.
///
/// It follows light and dark, Increase Contrast and Reduce Transparency as
/// they change, since layer colours are fixed values that do not update
/// themselves.
final class Surface: NSVisualEffectView {
    /// An opaque-ish wash over the blur, and it is not a style preference.
    ///
    /// `blendingMode = .behindWindow` composites whatever is behind the
    /// pill, so an editor's panel dividers came through it as a faint
    /// rectangle that read as a border the widget was drawing. The wash
    /// keeps enough blur to feel native while making the pill read as one
    /// solid object wherever it is parked.
    private let wash = NSView()

    /// Lays out the pill's row and its answer on every size change. Set by
    /// the panel: the row stays put while the widget grows around it, which
    /// autoresizing masks cannot say.
    var layoutContent: ((NSRect) -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        material = .popover
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = Brand.Radius.lg
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        // The layer's corners clip the wash and the answer, but not the
        // blur: the window server draws that behind the whole rectangle
        // unless the view has a mask image of the same shape.
        maskImage = Self.mask(radius: Brand.Radius.lg)

        wash.wantsLayer = true
        wash.frame = bounds
        wash.autoresizingMask = [.width, .height]
        addSubview(wash)

        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(displayOptionsChanged),
            name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        restyle()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// The pill's own shape, or a circle `diameter` across for the pill
    /// reduced to its orb. The stretchable mask cannot make a circle: its
    /// corners would be wider than the view.
    func shape(circle diameter: CGFloat?) {
        guard let diameter else {
            layer?.cornerRadius = Brand.Radius.lg
            layer?.cornerCurve = .continuous
            maskImage = Self.mask(radius: Brand.Radius.lg)
            return
        }
        layer?.cornerRadius = diameter / 2
        layer?.cornerCurve = .circular
        maskImage = NSImage(size: NSSize(width: diameter, height: diameter), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        layoutContent?(bounds)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        restyle()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        restyle()
    }

    @objc private func displayOptionsChanged() { restyle() }

    /// A stretchable continuous-corner shape: the corners stay, the middle
    /// stretches to any size.
    private static func mask(radius: CGFloat) -> NSImage {
        // A continuous corner starts bending before `radius` from the edge.
        let cap = ceil(radius * 1.6)
        let side = cap * 2 + 1
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let shape = CALayer()
            shape.frame = rect
            shape.backgroundColor = NSColor.black.cgColor
            shape.cornerRadius = radius
            shape.cornerCurve = .continuous
            shape.render(in: ctx)
            return true
        }
        image.capInsets = NSEdgeInsets(top: cap, left: cap, bottom: cap, right: cap)
        image.resizingMode = .stretch
        return image
    }

    /// Colours for the current appearance and accessibility settings.
    private func restyle() {
        let ws = NSWorkspace.shared
        let contrast = ws.accessibilityDisplayShouldIncreaseContrast
        let solid = ws.accessibilityDisplayShouldReduceTransparency
        effectiveAppearance.performAsCurrentDrawingAppearance {
            wash.layer?.backgroundColor = NSColor.windowBackgroundColor
                .withAlphaComponent(solid || contrast ? 0.96 : 0.72).cgColor
            // One device pixel: a hairline, as system popovers have. With
            // Increase Contrast it becomes a clear line in the text colour.
            layer?.borderColor = (contrast ? NSColor.labelColor.withAlphaComponent(0.6) : NSColor.separatorColor).cgColor
            layer?.borderWidth = (contrast ? 1.5 : 1) / (window?.backingScaleFactor ?? 2)
        }
    }
}
