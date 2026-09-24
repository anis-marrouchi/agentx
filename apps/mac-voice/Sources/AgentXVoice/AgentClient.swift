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
        /// The agent that answered and its ElevenLabs voice, when it has one.
        let agentID: String?
        let voiceID: String?
    }

    /// What, if anything, to say about the step now running.
    ///
    /// The daemon decides, because the phrasing lives with the model that
    /// chooses it. Returning nil is the common and correct case — most
    /// steps are not worth interrupting for, and the pill already shows
    /// every one of them to anyone looking.
    ///
    /// Never throws: a narration that fails is silence, which is exactly
    /// what it would have been anyway.
    static func phrase(tool: String, detail: String, elapsed: Int) async -> String? {
        guard let url = URL(string: "\(Config.daemonURL)/voice/phrase") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        // Shorter than the turn it narrates: a phrase that arrives late
        // describes work already finished.
        req.timeoutInterval = 6
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "tool": tool, "detail": detail, "elapsedSeconds": elapsed,
        ])
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        struct Reply: Decodable { let say: String? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.say
    }

    // MARK: Talk mode
    //
    // While two agents talk out loud (`agentx talk`), Option-Space is the
    // door: pressing it hushes them at once, and what is said goes to the
    // talk instead of /ask. See src/daemon/voice-talk-api.ts.

    /// Silence a running talk. Returns whether one is running, so the
    /// caller knows where the words about to be spoken should go. Never
    /// throws: no daemon means no talk.
    static func talkHush() async -> Bool {
        guard let (data, _) = try? await post("/talk/hush", [:], timeout: 2) else { return false }
        struct Reply: Decodable { let active: Bool? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.active ?? false
    }

    /// Hand the listener's words to the talk; "stop" ends it.
    static func talkDoor(_ text: String) async throws {
        let (_, response) = try await post("/talk/door", ["text": text], timeout: 5)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw NSError(domain: "AgentXVoice", code: http.statusCode,
                          userInfo: [NSLocalizedDescriptionKey: "The talk has ended"])
        }
    }

    private static func post(_ path: String, _ body: [String: Any], timeout: TimeInterval) async throws -> (Data, URLResponse) {
        var req = URLRequest(url: URL(string: "\(Config.daemonURL)\(path)")!)
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await URLSession.shared.data(for: req)
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
            "session": Config.voiceSession,
        ])

        let (data, response) = try await URLSession.shared.data(for: req)
        struct UiButton: Decodable { let label: String; let url: String }
        struct UiMedia: Decodable { let type: String; let url: String; let caption: String? }
        struct Ui: Decodable { let buttons: [UiButton]?; let media: UiMedia? }
        struct Voice: Decodable { let elevenlabsVoiceId: String? }
        struct Reply: Decodable {
            let agentId: String?
            let voice: Voice?
            let text: String?
            let full: String?
            let ui: Ui?
            let error: String?
            let duration: Int?
        }
        let reply = try? JSONDecoder().decode(Reply.self, from: data)
        let voiceID = reply?.voice?.elevenlabsVoiceId

        // 202 means accepted-but-busy: the daemon has already written a
        // speakable explanation into `text`. Falling through to the error
        // path here is what made "she is still working" sound like "that
        // didn't work".
        if let http = response as? HTTPURLResponse, http.statusCode == 202,
           let queuedText = reply?.text, !queuedText.isEmpty {
            return Answer(text: queuedText, written: nil, buttons: [], imageURL: nil,
                          durationMs: reply?.duration, agentID: reply?.agentId, voiceID: voiceID)
        }

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
                      durationMs: reply?.duration, agentID: reply?.agentId, voiceID: voiceID)
    }
}
