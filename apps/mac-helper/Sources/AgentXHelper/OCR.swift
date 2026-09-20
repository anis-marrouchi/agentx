import AppKit
import Vision

/// Reading the screen when the accessibility tree has nothing to say.
///
/// Electron apps are the reason this exists. VS Code exposes three
/// controls and labels none of them; Screen Studio's own recording picker
/// exposes no children at all. To the tree those screens look empty, which
/// is indistinguishable from an app with genuinely nothing on it — so a
/// lesson or an agent asked to act there has no candidates and can only
/// refuse.
///
/// Apple's Vision framework reads the pixels instead. Entirely local: the
/// image never leaves the machine, which is the same posture third-hand
/// takes and the opposite of shipping screenshots to a vision model.
///
/// What this buys and what it does not. OCR returns TEXT AND WHERE IT IS.
/// It does not return affordances — it cannot tell a button from its own
/// caption, or a disabled control from an enabled one. So an OCR
/// candidate is a weaker thing than a tree element and is marked as such,
/// rather than quietly mixed in as though the two were equivalent.
enum OCR {

    struct TextHit: Codable {
        let text: String
        /// Screen coordinates, top-left origin — the same convention the
        /// accessibility tree uses, so callers need no second mapping.
        let x: Double
        let y: Double
        let width: Double
        let height: Double
        let confidence: Double
    }

    /// Read text from a screen rectangle.
    ///
    /// `rect` is in screen coordinates with a TOP-LEFT origin, matching
    /// AXTree. Everything about coordinates here is a conversion between
    /// three conventions and it is the part most likely to be wrong, so
    /// each step is named:
    ///
    ///   1. CGWindowListCreateImage takes top-left screen coords. Good.
    ///   2. The image comes back at backing scale — 2x on Retina — so its
    ///      pixel size is not the rect's point size.
    ///   3. Vision reports NORMALISED coordinates (0…1) with a BOTTOM-LEFT
    ///      origin, relative to the image.
    ///
    /// So a hit is un-normalised against the image, flipped vertically,
    /// and finally offset by the rect's own origin.
    static func read(rect: CGRect, languages: [String] = ["fr-FR", "en-US"]) -> [TextHit] {
        guard rect.width >= 8, rect.height >= 8,
              let image = CGWindowListCreateImage(
                rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
        else { return [] }

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        // The machine under test is French and pages render in French;
        // an English-only recogniser drops accented words entirely.
        request.recognitionLanguages = languages
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        guard (try? handler.perform([request])) != nil,
              let observations = request.results
        else { return [] }

        var hits: [TextHit] = []
        for obs in observations {
            guard let candidate = obs.topCandidates(1).first else { continue }
            let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
            // Single stray characters are noise from borders and icons.
            guard text.count > 1 else { continue }

            // Vision box: normalised, bottom-left origin, relative to image.
            let b = obs.boundingBox
            let w = b.width * rect.width
            let h = b.height * rect.height
            let x = rect.minX + b.minX * rect.width
            // Flip: Vision's y grows upward from the image bottom; screen
            // coordinates grow downward from the rect top.
            let y = rect.minY + (1.0 - b.maxY) * rect.height

            hits.append(TextHit(text: text, x: x, y: y, width: w, height: h,
                                confidence: Double(candidate.confidence)))
        }
        // Reading order: top to bottom, then left to right. Matches how a
        // person would enumerate what is on screen.
        return hits.sorted { a, b in
            abs(a.y - b.y) > 6 ? a.y < b.y : a.x < b.x
        }
    }

    /// The focused window's frame, in top-left screen coordinates.
    ///
    /// Capturing the whole screen would work and is worse: more to read,
    /// slower, and it pulls in every other application's content.
    static func focusedWindowFrame() -> CGRect? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              CFGetTypeID(windowRef) == AXUIElementGetTypeID()
        else { return nil }
        let window = unsafeBitCast(windowRef, to: AXUIElement.self)

        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success
        else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
        guard s.width > 0, s.height > 0 else { return nil }
        return CGRect(origin: p, size: s)
    }
}
