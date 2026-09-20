import AppKit

/// Noqta design tokens, transcribed for AppKit.
///
/// Copied from the design system's `tokens/` rather than eyeballed, so the
/// widget belongs to the same product as noqta.tn instead of merely
/// looking tidy. Two rules from that system shape most of what follows:
///
///   - Mono is UPPERCASE with 0.06–0.08em tracking, and is reserved for
///     eyebrows, status and meta. Body stays sentence case.
///   - No emoji, ever. Texture comes from Unicode punctuation — · → ● ✓ —
///     and from a single accent colour, not from decoration.
///
/// System colours were the obvious default and the wrong one: .systemRed
/// and .systemGreen are macOS's voice, not Noqta's, and they shift under
/// the user's accent-colour setting.
enum Brand {

    // Teal accent and deep blue primary — the two colours the whole
    // identity rests on.
    static let accent = NSColor(srgbRed: 0.078, green: 0.722, blue: 0.651, alpha: 1)      // #14b8a6
    static let accentDeep = NSColor(srgbRed: 0.059, green: 0.463, blue: 0.431, alpha: 1)  // #0f766e
    static let primary = NSColor(srgbRed: 0.118, green: 0.227, blue: 0.541, alpha: 1)     // #1e3a8a
    static let primaryBright = NSColor(srgbRed: 0.114, green: 0.306, blue: 0.847, alpha: 1) // #1d4ed8

    static let ink = NSColor(srgbRed: 0.043, green: 0.078, blue: 0.075, alpha: 1)         // #0b1413
    static let paper = NSColor(srgbRed: 0.980, green: 0.980, blue: 0.976, alpha: 1)       // #fafaf9

    /// Amber and rose for states the palette has no token for. Muted to
    /// sit beside the teal rather than fight it.
    static let warn = NSColor(srgbRed: 0.851, green: 0.596, blue: 0.180, alpha: 1)
    static let alert = NSColor(srgbRed: 0.804, green: 0.400, blue: 0.376, alpha: 1)

    enum Radius {
        static let sm: CGFloat = 6
        static let base: CGFloat = 10
        static let md: CGFloat = 12
        static let lg: CGFloat = 18
        static let pill: CGFloat = 999
    }

    /// `--nq-ease` — the single easing curve the system uses everywhere.
    static let ease = CAMediaTimingFunction(controlPoints: 0.65, 0, 0.35, 1)
    static let durFast: CFTimeInterval = 0.15

    /// Meta type: mono, uppercase, tracked. Eyebrows and status only.
    static func meta(size: CGFloat = 10.5) -> [NSAttributedString.Key: Any] {
        [
            .font: NSFont.monospacedSystemFont(ofSize: size, weight: .semibold),
            .kern: size * 0.07,
        ]
    }

    static func metaString(_ text: String, size: CGFloat = 10.5, color: NSColor) -> NSAttributedString {
        var attrs = meta(size: size)
        attrs[.foregroundColor] = color
        return NSAttributedString(string: text.uppercased(), attributes: attrs)
    }

    static func body(size: CGFloat = 13, weight: NSFont.Weight = .medium) -> NSFont {
        NSFont.systemFont(ofSize: size, weight: weight)
    }

    /// The CSS the result card renders markdown into. Same tokens, so an
    /// answer reads like the product it came from.
    static let cardCSS = """
      :root {
        color-scheme: light dark;
        --nq-accent: #14b8a6;
        --nq-primary: #1e3a8a;
        --nq-ink: #0b1413;
        --nq-paper: #fafaf9;
        --nq-radius-sm: 6px;
        --nq-radius: 10px;
      }
      @media (prefers-color-scheme: dark) {
        :root { --nq-ink: #f4f4f2; --nq-primary: #93c5fd; }
      }
      body {
        font: 13px/1.55 -apple-system, 'Geist', system-ui, sans-serif;
        margin: 14px 14px 10px; color: canvastext; background: transparent;
        word-wrap: break-word; -webkit-font-smoothing: antialiased;
      }
      h1, h2, h3, h4 {
        margin: .75em 0 .3em; font-size: 1.02em; font-weight: 650;
        letter-spacing: -0.005em;
      }
      h1:first-child, h2:first-child, h3:first-child { margin-top: 0; }
      p { margin: .45em 0; }
      ul { margin: .4em 0; padding-left: 1.15em; }
      li { margin: .2em 0; }
      li::marker { color: var(--nq-accent); }
      strong { font-weight: 640; }
      code {
        font: 11.5px ui-monospace, 'Geist Mono', SFMono-Regular, monospace;
        background: color-mix(in srgb, var(--nq-accent) 12%, transparent);
        padding: 1.5px 5px; border-radius: var(--nq-radius-sm);
      }
      pre {
        background: color-mix(in srgb, canvastext 7%, transparent);
        padding: 10px 12px; border-radius: var(--nq-radius);
        overflow-x: auto; line-height: 1.45;
        border-left: 2px solid color-mix(in srgb, var(--nq-accent) 55%, transparent);
      }
      pre code { background: none; padding: 0; }
      blockquote {
        margin: .5em 0; padding-left: .85em;
        border-left: 2px solid color-mix(in srgb, var(--nq-accent) 45%, transparent);
        opacity: .85;
      }
      a { color: var(--nq-primary); text-underline-offset: 2px; }
      hr {
        border: none; margin: 1em 0;
        border-top: 1px solid color-mix(in srgb, canvastext 14%, transparent);
      }
      table { border-collapse: collapse; margin: .5em 0; font-size: 12px; }
      th, td { padding: 4px 9px; border: 1px solid color-mix(in srgb, canvastext 14%, transparent); }
      th {
        font: 10px ui-monospace, monospace; text-transform: uppercase;
        letter-spacing: .07em; text-align: left; font-weight: 600;
      }
    """
}
