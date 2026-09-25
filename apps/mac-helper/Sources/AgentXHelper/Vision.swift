import AppKit
import ApplicationServices

/// Eyes. Two of them, because "can I see it" and "did it work" are
/// different questions with different right answers.
///
/// Everything else in this helper reads the accessibility tree, which
/// reports what EXISTS and where, and says nothing about what is VISIBLE.
/// Z-order, overlays, opacity, a modal on top, something scrolled out of
/// view — all invisible to it. An element can be reported at (218, 145)
/// with perfect confidence while something else sits on top of it.
///
/// That is not hypothetical. This tool's own HUD covered the search field
/// it was pointing at, and nothing in the pipeline could tell. The
/// obstruction was self-inflicted and still undetectable.
///
/// So:
///
///   hitTest  — is the thing I mean actually on top at that point?
///              Uses the accessibility hit test, which is exact and costs
///              no pixels. This is the check that catches occlusion.
///
///   capture  — what does this region look like right now? Used in pairs,
///              before and after, to answer "did anything change" — which
///              is the only honest way to claim an action landed.
enum Vision {

    // MARK: Occlusion

    struct HitResult: Codable {
        /// Role of whatever is topmost at the point.
        let role: String
        let label: String
        /// The frontmost app owning it — a different app here usually means
        /// a floating panel is in the way.
        let app: String
        /// True when the topmost element's frame matches the one asked
        /// about, within a tolerance.
        let matchesExpected: Bool?
        /// "role label" of the elements containing it, nearest first. Web
        /// controls answer a hit test with an unnamed inner node (the icon,
        /// the text span); the control that carries the name is a parent.
        let ancestors: [String]
    }

    /// What is actually on top at a screen point.
    ///
    /// AXUIElementCopyElementAtPosition resolves through the window server,
    /// so it sees exactly what a click would hit — including overlays this
    /// process put there itself.
    static func hitTest(x: Double, y: Double, expect: CGRect? = nil) -> HitResult? {
        let system = AXUIElementCreateSystemWide()
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &ref) == .success,
              let element = ref
        else { return nil }

        let role = attr(element, kAXRoleAttribute) ?? ""
        let label = name(element)
        var ancestors: [String] = []
        var node = element
        for _ in 0..<8 {
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(node, kAXParentAttribute as CFString, &parent) == .success,
                  let p = parent, CFGetTypeID(p) == AXUIElementGetTypeID() else { break }
            node = p as! AXUIElement
            ancestors.append("\(attr(node, kAXRoleAttribute) ?? "") \(name(node))")
        }

        var owner = "unknown"
        var pid: pid_t = 0
        if AXUIElementGetPid(element, &pid) == .success,
           let app = NSRunningApplication(processIdentifier: pid) {
            owner = app.localizedName ?? "unknown"
        }

        var matches: Bool?
        if let expect {
            // Compare frames rather than identity: AXUIElement references
            // are not stable across calls, so two handles to the same
            // control are not equal even when they should be.
            if let f = frame(element) {
                let dx = abs(f.midX - expect.midX), dy = abs(f.midY - expect.midY)
                // Generous, because a hit inside the intended control is a
                // hit even if the tree reports a child of it.
                matches = dx <= max(expect.width, 24) && dy <= max(expect.height, 24)
            } else {
                matches = false
            }
        }
        return HitResult(role: role, label: label, app: owner, matchesExpected: matches, ancestors: ancestors)
    }

    // MARK: Capture

    /// Grab a screen region to a PNG.
    ///
    /// CGWindowListCreateImage rather than ScreenCaptureKit: this is a
    /// one-shot CLI, and SCK's async setup costs more than the capture. It
    /// needs Screen Recording permission; without it macOS returns a
    /// desktop-only image rather than failing, which is why the caller is
    /// told to check for an all-uniform result.
    ///
    /// `maxPixels` caps the TOTAL area before writing, and `maxWidth` the
    /// long edge. Prefer the area budget.
    ///
    /// Cost tracks pixel count, not width, and capping width alone throws
    /// away detail on small regions while saving nothing. A menu bar strip
    /// is 2880x52 on this display — 150k pixels, a couple of hundred
    /// tokens — and scaling it to 1400 wide halves the resolution of the
    /// only thing in it worth seeing. A full screen is 5.2M pixels and
    /// genuinely does need cutting. One rule covers both: leave it alone
    /// unless it is actually big.
    ///
    /// Resolution here is not a cost knob, it is the difference between a
    /// legible indicator and a grey smudge. macOS draws the screen-
    /// recording dot at about six points.
    @discardableResult
    static func capture(_ rect: CGRect, to path: String,
                        maxWidth: Int? = nil, maxPixels: Int? = nil) -> Bool {
        guard let image = CGWindowListCreateImage(
            rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
        else { return false }
        var target = maxWidth
        if let budget = maxPixels, budget > 0 {
            let area = image.width * image.height
            if area > budget {
                // Preserve aspect: width * (width / aspect) = budget.
                let scale = (Double(budget) / Double(area)).squareRoot()
                let fit = max(1, Int(Double(image.width) * scale))
                target = min(target ?? fit, fit)
            }
        }
        let out = target.flatMap { downscale(image, maxWidth: $0) } ?? image
        let rep = NSBitmapImageRep(cgImage: out)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }

    /// Returns nil when the image is already narrow enough, so the caller
    /// falls back to the original rather than paying for a pointless redraw.
    private static func downscale(_ image: CGImage, maxWidth: Int) -> CGImage? {
        guard maxWidth > 0, image.width > maxWidth else { return nil }
        let height = max(1, Int(Double(image.height) * Double(maxWidth) / Double(image.width)))
        guard let ctx = CGContext(
            data: nil, width: maxWidth, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        // High, not low: this image exists to be READ. Cheap interpolation
        // turns small text into grey mush and the model then reports an
        // empty menu bar with complete confidence.
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: maxWidth, height: height))
        return ctx.makeImage()
    }

    /// Mean absolute difference between two regions, 0…1.
    ///
    /// Downsamples hard before comparing: the question is "did this change
    /// meaningfully", not "is a single antialiased pixel different", and a
    /// small grid also makes the comparison immune to a one-pixel shift.
    static func difference(_ a: CGRect, _ b: CGImage?) -> Double? {
        guard let now = CGWindowListCreateImage(a, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]),
              let before = b
        else { return nil }
        guard let g1 = grid(before), let g2 = grid(now), g1.count == g2.count, !g1.isEmpty
        else { return nil }
        var total = 0.0
        for i in 0..<g1.count { total += abs(Double(g1[i]) - Double(g2[i])) / 255.0 }
        return total / Double(g1.count)
    }

    static func snapshot(_ rect: CGRect) -> CGImage? {
        CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
    }

    /// 16×16 greyscale, which is plenty to notice a page changing and
    /// cheap enough to run between every action.
    private static func grid(_ image: CGImage, side: Int = 16) -> [UInt8]? {
        let space = CGColorSpaceCreateDeviceGray()
        var pixels = [UInt8](repeating: 0, count: side * side)
        guard let ctx = CGContext(data: &pixels, width: side, height: side,
                                  bitsPerComponent: 8, bytesPerRow: side,
                                  space: space, bitmapInfo: 0)
        else { return nil }
        ctx.interpolationQuality = .low
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
        return pixels
    }

    // MARK: Helpers

    /// Whether an element named `expected` covers the point in the window
    /// that `hit` belongs to. Chromium answers a hit test on a web app's
    /// toolbar with an unnamed full-window layer, not the button under it;
    /// the window server has still decided which window is in front, so
    /// looking inside that window for the named control is safe.
    static func windowShows(_ expected: String, at p: CGPoint) -> Bool {
        let system = AXUIElementCreateSystemWide()
        var ref: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &ref) == .success,
              let hit = ref else { return false }
        // Web nodes often lack AXWindow; climb to it instead.
        var w = hit
        for _ in 0..<32 where attr(w, kAXRoleAttribute) != kAXWindowRole {
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(w, kAXParentAttribute as CFString, &parent) == .success,
                  let up = parent, CFGetTypeID(up) == AXUIElementGetTypeID() else { break }
            w = up as! AXUIElement
        }
        let want = expected.lowercased()
        var stack = [w]
        var budget = 3000
        while let node = stack.popLast(), budget > 0 {
            budget -= 1
            if let f = frame(node), !f.contains(p), f.width >= 1 { continue }
            if "\(attr(node, kAXRoleAttribute) ?? "") \(name(node))".lowercased().contains(want) { return true }
            var kids: CFTypeRef?
            if AXUIElementCopyAttributeValue(node, kAXChildrenAttribute as CFString, &kids) == .success,
               let children = kids as? [AXUIElement] { stack.append(contentsOf: children) }
        }
        return false
    }

    private static func name(_ node: AXUIElement) -> String {
        [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute]
            .compactMap { attr(node, $0) }
            .first(where: { !$0.isEmpty }) ?? ""
    }

    private static func attr(_ node: AXUIElement, _ name: String) -> String? {
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, name as CFString, &ref) == .success else { return nil }
        if let s = ref as? String { return s.trimmingCharacters(in: .whitespacesAndNewlines) }
        return nil
    }

    private static func frame(_ node: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(node, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(node, kAXSizeAttribute as CFString, &sizeRef) == .success
        else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
        return CGRect(origin: p, size: s)
    }
}
