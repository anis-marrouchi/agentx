import AppKit
import SwiftUI

/// The settings window's look controls (#211): each agent's orb palette,
/// and how long and how tall the answer in the pill is. Both are saved in
/// agentx.json through the daemon, like everything else in the window.

/// A palette as a small gradient disc, for menus that only show images.
enum PaletteSwatch {
    static func image(_ hexes: [String], size: CGFloat = 14) -> NSImage {
        let colors = hexes.compactMap(OrbMath.parseHex).map { NSColor(srgbRed: $0.r, green: $0.g, blue: $0.b, alpha: 1) }
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let disc = NSBezierPath(ovalIn: rect.insetBy(dx: 0.5, dy: 0.5))
            NSGradient(colors: colors.isEmpty ? [.gray] : colors)?.draw(in: disc, angle: -45)
            NSColor.separatorColor.setStroke()
            disc.lineWidth = 0.5
            disc.stroke()
            return true
        }
    }
}

/// "Orb palette": one of the nature palettes, or the one nearest the
/// agent's colour.
struct PalettePicker: View {
    @Binding var agent: VoiceSettings.Agent
    let palettes: [VoiceSettings.Palette]

    private func palette(_ id: String?) -> VoiceSettings.Palette? { palettes.first { $0.id == id } }

    var body: some View {
        let shown = palette(agent.palette ?? agent.paletteDefault)
        HStack {
            Picker("Orb palette", selection: $agent.palette) {
                if let fallback = palette(agent.paletteDefault) {
                    Label { Text("Match the colour: \(fallback.label)") } icon: { Image(nsImage: PaletteSwatch.image(fallback.colors)) }
                        .tag(String?.none)
                } else {
                    Text("Match the colour").tag(String?.none)
                }
                Divider()
                ForEach(palettes) { p in
                    Label { Text(p.label) } icon: { Image(nsImage: PaletteSwatch.image(p.colors)) }
                        .tag(String?.some(p.id))
                }
            }
            if let shown {
                Image(nsImage: PaletteSwatch.image(shown.colors, size: 20))
                    .accessibilityHidden(true)
            }
        }
    }
}

/// "Shown as": the orb, or the character that stands in for it (#458).
struct LookSection: View {
    @Binding var look: String
    /// Nil hides the control: the daemon is older than the reduced pill.
    var startReduced: Binding<Bool>?
    /// Nil hides the control: the daemon is older than the stroll.
    var stroll: Binding<Bool>?
    /// Nil hides the control: the daemon is older than the animations.
    var animations: Binding<String>?

    var body: some View {
        Section {
            Picker("Shown as", selection: $look) {
                Text("Orb").tag("orb")
                Text("Character").tag("character")
            }
            if let startReduced {
                Toggle("Start reduced to the orb", isOn: startReduced)
                    .disabled(look == "character")
            }
            if let stroll {
                Toggle("Character strolls when idle", isOn: stroll)
                    .disabled(look != "character")
            }
            if let animations {
                Picker("Character plays when idle", selection: animations) {
                    Text("Never").tag("off")
                    Text("Rarely").tag("rarely")
                    Text("Sometimes").tag("sometimes")
                    Text("Often").tag("often")
                }
                .disabled(look != "character")
            }
        } header: {
            Text("Assistant")
        } footer: {
            Text("The character is the orb grown into a small creature in the agent's colours. It hovers above the bottom edge of the screen, shows what the assistant is doing, and moves out of the pointer's way. It never takes a click.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// "Answer in the pill": how long it stays open once spoken, and how tall
/// it grows before it scrolls.
struct AnswerCardSection: View {
    @Binding var card: VoiceSettings.Card

    /// The usual choices, plus whatever agentx.json already says.
    private var timeouts: [Double] {
        let usual: [Double] = [10, 20, 30, 60, 120, 300]
        return usual.contains(card.timeout) || card.timeout == 0 ? usual : (usual + [card.timeout]).sorted()
    }

    private static func label(_ s: Double) -> String {
        if s < 60 || s.truncatingRemainder(dividingBy: 60) != 0 { return "\(Int(s)) seconds" }
        return s == 60 ? "1 minute" : "\(Int(s / 60)) minutes"
    }

    var body: some View {
        Section {
            Picker("Keep the answer open", selection: $card.timeout) {
                ForEach(timeouts, id: \.self) { s in
                    Text(Self.label(s)).tag(s)
                }
                Divider()
                Text("Until I close it").tag(0.0)
            }
            Stepper(value: $card.maxHeight, in: 120...800, step: 40) {
                LabeledContent("Tallest answer", value: "\(Int(card.maxHeight)) points")
            }
        } header: {
            Text("Answer in the pill")
        } footer: {
            Text("When an answer has a link, a picture or more to read than was spoken, the pill grows to show it. It closes this long after the answer has been spoken, but not while the pointer is over it. A longer answer scrolls.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
