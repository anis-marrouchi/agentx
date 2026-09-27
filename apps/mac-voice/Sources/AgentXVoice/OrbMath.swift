import Foundation

/// The numbers behind the orb, kept free of AppKit and SwiftUI so the
/// tests can check them without a window.
enum OrbMath {
    /// The palette the daemon derives an agent's colour from when
    /// `presence.color` is unset. Same list, same order and same hash as
    /// `presenceLook` in src/voice/presence.ts, so the orb matches the
    /// agent's on-screen cursor even when /agents sends no colour.
    static let palette = ["#7C3AED", "#DB2777", "#EA580C", "#0D9488",
                          "#2563EB", "#65A30D", "#C026D3", "#0891B2"]

    /// The colour for an agent: the daemon's when it sent one, else the
    /// hash of the id.
    static func colorHex(agentID: String, configured: String?) -> String {
        if let c = configured, parseHex(c) != nil { return c }
        var h: UInt32 = 0
        // JS iterates code points and takes charCodeAt(0) of each: the
        // first UTF-16 unit. Identical for every ASCII id.
        for scalar in agentID.unicodeScalars {
            let unit = UInt32(String(scalar).utf16.first ?? 0)
            h = h &* 31 &+ unit
        }
        return palette[Int(h % UInt32(palette.count))]
    }

    /// "#RRGGBB" as 0…1 components, or nil when it is not that.
    static func parseHex(_ s: String) -> (r: Double, g: Double, b: Double)? {
        guard s.count == 7, s.hasPrefix("#"), let v = UInt32(s.dropFirst(), radix: 16) else { return nil }
        return (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
    }

    /// Microphone RMS (about 0.005 in a quiet room, 0.02 for a voice,
    /// 0.2 when shouting) to 0…1. Square root, because loudness is heard
    /// roughly that way: linear made normal speech barely move the orb.
    static func level(fromRMS rms: Float) -> Double {
        guard rms.isFinite, rms > 0.004 else { return 0 }
        return min(1, Double((rms - 0.004).squareRoot()) * 3.2)
    }

    /// A speech-like rise and fall at time `t`, 0.15…1: syllables at about
    /// five a second under a slower phrase swell. The daemon plays the
    /// answer, so the app cannot meter it; this keeps the orb talking in
    /// rhythm without pretending to be a level meter.
    static func speakingEnvelope(at t: Double) -> Double {
        let syllable = abs(sin(t * 15.7))
        let phrase = 0.55 + 0.45 * sin(t * 1.9 + 0.7)
        let jitter = 0.5 + 0.5 * sin(t * 37.3 + sin(t * 3.1))
        return 0.15 + 0.85 * syllable * phrase * (0.7 + 0.3 * jitter)
    }

    /// Smooth toward `target`: fast attack, slower release, as the
    /// recorder does, so the orb swells with a word and settles after it.
    static func smooth(_ current: Double, toward target: Double) -> Double {
        target > current ? current + (target - current) * 0.6 : current + (target - current) * 0.2
    }
}
