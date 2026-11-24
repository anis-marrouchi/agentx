import AppKit

/// AgentX design tokens, transcribed for AppKit from the one token module
/// the dashboard, the Hub and the phone share (src/daemon/ui/tokens.ts,
/// #2101 / #2111): Orca's neutral look with AgentX blue, Geist type, 1px
/// lines and a 10px radius. Each colour has its light and dark value, as
/// `:root` and `[data-theme="dark"]` there, and follows the Mac's setting.
///
/// Two rules kept from before:
///
///   - Mono is UPPERCASE with 0.06–0.08em tracking, and is reserved for
///     eyebrows, status and meta. Body stays sentence case.
///   - No emoji, ever. Texture comes from Unicode punctuation — · → ● ✓ —
///     and from a single accent colour, not from decoration.
///
/// System colours stay out: .systemRed and .systemGreen are macOS's voice,
/// not AgentX's, and they shift under the user's accent-colour setting.
enum Brand {

    /// A colour with its light and dark value, read when it is drawn.
    static func pair(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { look in
            rgb(look.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light)
        }
    }

    static func rgb(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
        NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
                blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
    }

    // AgentX blue: links, the listening state and the default agent tint
    // (--ax-accent / --ax-blue), and its deeper step (--ax-blue-d).
    static let accent = pair(0x1f66e5, 0x4d94ff)
    static let accentDeep = pair(0x1a56c4, 0x2979ff)
    /// The primary button, the same in both themes (white on it is 5.1:1).
    static let primary = rgb(0x1f66e5)
    /// The focus ring and working state (--ax-ring).
    static let primaryBright = pair(0x2979ff, 0x4d94ff)

    static let ink = pair(0x0a0a0a, 0xf0f0f0)          // --ax-text
    static let inkSoft = pair(0x525252, 0xc4c4c4)      // --ax-text-2
    static let paper = pair(0xffffff, 0x0a0a0a)        // --ax-bg
    static let surface = pair(0xffffff, 0x171717)      // --ax-surface

    /// Amber, red and green: the token module's status colours.
    static let warn = pair(0xf59e0b, 0xfbbf24)
    static let alert = pair(0xe40014, 0xff6568)
    static let alertInk = pair(0xb00010, 0xff8a8c)     // red that carries words
    static let ok = pair(0x16a34a, 0x4ade80)

    enum Radius {
        static let sm: CGFloat = 6
        static let base: CGFloat = 10
        static let md: CGFloat = 10
        static let lg: CGFloat = 14
        static let pill: CGFloat = 999
    }

    // MARK: Geist

    /// Geist and Geist Mono (SIL OFL 1.1, (c) 2023 Vercel; the licence is
    /// next to them in the bundle's Resources). Registered for this app
    /// only, at launch. Missing files leave the system font in place.
    static func registerFonts(bundle: Bundle = .main) {
        for name in ["Geist-Variable", "GeistMono-Variable"] {
            guard let url = bundle.url(forResource: name, withExtension: "woff2")
                ?? bundle.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    /// Geist for the answer card. The card's web view runs in its own
    /// process, which does not see fonts registered here, and the daemon
    /// does not serve the dashboard's /assets; so the bundled file goes in
    /// as a data URL, read once. Empty without the file.
    static let cardFontCSS: String = {
        guard let url = Bundle.main.url(forResource: "Geist-Variable", withExtension: "woff2"),
              let data = try? Data(contentsOf: url) else { return "" }
        return "@font-face { font-family: 'Geist'; font-weight: 100 900; src: url(data:font/woff2;base64,\(data.base64EncodedString())) format('woff2'); }\n"
    }()

    /// Geist at a size and weight, or the system font when Geist is absent.
    static func font(size: CGFloat, weight: NSFont.Weight = .regular, mono: Bool = false) -> NSFont {
        let family = mono ? "Geist Mono" : "Geist"
        let desc = NSFontDescriptor(fontAttributes: [.family: family])
            .addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: weight]])
        if let f = NSFont(descriptor: desc, size: size), f.familyName == family { return f }
        return mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    }

    /// `--nq-ease` — the single easing curve the system uses everywhere.
    static let ease = CAMediaTimingFunction(controlPoints: 0.65, 0, 0.35, 1)
    static let durFast: CFTimeInterval = 0.15

    /// Meta type: mono, uppercase, tracked. Eyebrows and status only.
    static func meta(size: CGFloat = 10.5) -> [NSAttributedString.Key: Any] {
        [
            .font: font(size: size, weight: .semibold, mono: true),
            .kern: size * 0.07,
        ]
    }

    static func metaString(_ text: String, size: CGFloat = 10.5, color: NSColor) -> NSAttributedString {
        var attrs = meta(size: size)
        attrs[.foregroundColor] = color
        return NSAttributedString(string: text.uppercased(), attributes: attrs)
    }

    static func body(size: CGFloat = 13, weight: NSFont.Weight = .medium) -> NSFont {
        font(size: size, weight: weight)
    }

    /// The CSS the result card renders markdown into. Same tokens, so an
    /// answer reads like the product it came from.
    static let cardCSS = """
      :root {
        color-scheme: light dark;
        --nq-accent: #1f66e5;
        --nq-primary: #1f66e5;
        --nq-ink: #0a0a0a;
        --nq-paper: #ffffff;
        --nq-radius-sm: 6px;
        --nq-radius: 10px;
      }
      @media (prefers-color-scheme: dark) {
        :root { --nq-accent: #4d94ff; --nq-ink: #f0f0f0; --nq-primary: #4d94ff; --nq-paper: #0a0a0a; }
      }
      body {
        font: 13px/1.55 'Geist', -apple-system, system-ui, sans-serif;
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
        font: 11.5px 'Geist Mono', ui-monospace, SFMono-Regular, monospace;
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
      .md-table { overflow-x: auto; }
      table { border-collapse: collapse; margin: .5em 0; font-size: 12px; }
      th, td { padding: 4px 9px; border: 1px solid color-mix(in srgb, canvastext 14%, transparent); }
      th {
        font: 10px 'Geist Mono', ui-monospace, monospace; text-transform: uppercase;
        letter-spacing: .07em; text-align: left; font-weight: 600;
      }
    """
}
