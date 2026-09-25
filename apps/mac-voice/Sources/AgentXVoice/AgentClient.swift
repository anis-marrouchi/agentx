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
        /// The agent that answered and how it sounds.
        let agentID: String?
        let voice: VoiceChoice?
        /// Presence mode the daemon chose for this turn (talk, teach, …).
        var presenceMode: String? = nil
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

    // MARK: The door
    //
    // Option-Space is one door for everything spoken: a talk, a live
    // lesson, task narration, an agent's bubble. Pressing it hushes all of
    // them at once; what is then said goes to the activity that was
    // speaking, which answers it first. See src/daemon/voice-talk-api.ts.

    /// What was speaking when the door opened.
    struct Hushed {
        /// "talk", "lesson" or "narration"; nil when nothing was.
        let kind: String?
        let agentID: String?
        static let nothing = Hushed(kind: nil, agentID: nil)
    }

    /// Silence everything the daemon is saying. Never throws: no daemon
    /// means nothing was speaking.
    static func hush() async -> Hushed {
        guard let (data, _) = try? await post("/voice/hush", [:], timeout: 2) else { return .nothing }
        struct Reply: Decodable { let kind: String?; let agentId: String? }
        let r = try? JSONDecoder().decode(Reply.self, from: data)
        return Hushed(kind: r?.kind, agentID: r?.agentId)
    }

    /// Hand the listener's words through the door. True when an activity
    /// took them (a talk or lesson answers; "stop" ends it); false means
    /// nothing did, and they are an ordinary question.
    static func door(_ text: String) async -> Bool {
        guard let (_, response) = try? await post("/voice/door", ["text": text], timeout: 5),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    /// Speak a line in a Siri voice. Only the daemon can: it switches the
    /// system voice for the line and back, one line at a time for every
    /// agent. Returns when the line is over (or hushed); false when the
    /// daemon did not take it.
    static func say(_ text: String, siriVoice: String) async -> Bool {
        guard let (_, response) = try? await post("/voice/say", ["text": text, "voice": siriVoice], timeout: 300),
              let http = response as? HTTPURLResponse else { return false }
        return http.statusCode == 200
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
        struct Presence: Decodable { let mode: String? }
        struct Reply: Decodable {
            let agentId: String?
            let voice: VoiceChoice?
            let presence: Presence?
            let text: String?
            let full: String?
            let ui: Ui?
            let error: String?
            let duration: Int?
        }
        let reply = try? JSONDecoder().decode(Reply.self, from: data)
        let voice = reply?.voice

        // 202 means accepted-but-busy: the daemon has already written a
        // speakable explanation into `text`. Falling through to the error
        // path here is what made "she is still working" sound like "that
        // didn't work".
        if let http = response as? HTTPURLResponse, http.statusCode == 202,
           let queuedText = reply?.text, !queuedText.isEmpty {
            return Answer(text: queuedText, written: nil, buttons: [], imageURL: nil,
                          durationMs: reply?.duration, agentID: reply?.agentId, voice: voice)
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
                      durationMs: reply?.duration, agentID: reply?.agentId, voice: voice,
                      presenceMode: reply?.presence?.mode)
    }
}
