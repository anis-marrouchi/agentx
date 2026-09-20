import Foundation

/// Talks to the local agentx daemon's /ask endpoint.
///
/// /ask already does the voice-specific work server-side: it prepends a
/// VOICE MODE instruction and returns `text` pre-flattened for TTS by
/// toSpeakable(). So this client deliberately does no prompt shaping of
/// its own — two places deciding how an agent should sound is how they
/// drift apart.
///
/// No auth header: the daemon exempts loopback (see mesh-auth.ts), and
/// this widget is loopback by definition. Pointing AGENTX_DAEMON_URL at a
/// remote node would need a token, which is why it isn't the default.
enum AgentClient {
    struct Answer {
        /// What to speak: short, no URLs, no markdown.
        let text: String
        /// What to show: the answer as written, with the links and
        /// formatting the spoken form had to drop.
        let written: String?
        /// Buttons and media from the agentx:ui directive, parsed server-side.
        let buttons: [(String, String)]
        let imageURL: String?
        let durationMs: Int?
    }

    static func ask(_ message: String) async throws -> Answer {
        var req = URLRequest(url: URL(string: "\(Config.daemonURL)/ask")!)
        req.httpMethod = "POST"
        // An agent turn routinely takes minutes. The default 60s would cut
        // off exactly the thoughtful answers worth waiting for.
        req.timeoutInterval = 600
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "message": message,
            "agent": Config.agentID,
        ])

        let (data, response) = try await URLSession.shared.data(for: req)
        struct UiButton: Decodable { let label: String; let url: String }
        struct UiMedia: Decodable { let type: String; let url: String; let caption: String? }
        struct Ui: Decodable { let buttons: [UiButton]?; let media: UiMedia? }
        struct Reply: Decodable {
            let text: String?
            let full: String?
            let ui: Ui?
            let error: String?
            let duration: Int?
        }
        let reply = try? JSONDecoder().decode(Reply.self, from: data)

        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            let detail = reply?.error ?? String(data: data.prefix(200), encoding: .utf8) ?? ""
            throw VoiceError.api("daemon HTTP \(http.statusCode): \(detail)")
        }
        if let err = reply?.error, !err.isEmpty { throw VoiceError.api(err) }
        guard let text = reply?.text ?? reply?.full, !text.isEmpty else {
            throw VoiceError.api("agent returned an empty answer")
        }
        let buttons = (reply?.ui?.buttons ?? []).map { ($0.label, $0.url) }
        // Only images are shown inline; a document or video is offered as a
        // link instead, because a card that cannot play it should not
        // pretend otherwise.
        let media = reply?.ui?.media
        let image = media?.type == "image" ? media?.url : nil
        let extra: [(String, String)] = (media != nil && image == nil)
            ? [(media!.caption ?? media!.type.capitalized, media!.url)] : []

        return Answer(text: text, written: reply?.full,
                      buttons: buttons + extra, imageURL: image,
                      durationMs: reply?.duration)
    }
}
