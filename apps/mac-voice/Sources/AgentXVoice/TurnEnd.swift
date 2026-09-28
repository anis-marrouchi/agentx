import Foundation

/// When a hands-free turn has ended: the person spoke, then stopped for
/// long enough that the sentence is over.
///
/// It is fed one audio frame at a time with how likely that frame is to be
/// speech (0…1) and how long it lasted. Two sources feed it:
///
/// - Silero VAD, 32 ms frames with a real probability. A voice model
///   tells a word from a fan, a keyboard or a café, so the noise of a room
///   neither holds the microphone open nor counts as talking.
/// - The old volume check when the VAD model is not available: 1 above
///   `speechLevel`, 0 below, per audio buffer.
///
/// Foundation only and time passed in, so the tests can drive it with
/// synthetic frames.
struct TurnEnd {
    struct Tuning: Equatable {
        /// A frame at or above this starts speech (Silero's own default).
        var start: Float
        /// Once talking, a frame at or above this still counts as speech.
        /// Lower than `start`: the soft end of a word is not a pause.
        var keep: Float
        /// Speech must last this long in one go before the turn counts as
        /// started, so a cough, a door or a click does not open it.
        var minSpeech: TimeInterval
        /// A burst this short inside a pause does not restart the pause:
        /// one noisy frame must not hold the microphone open.
        var resume: TimeInterval
        /// A pause this long after speech ends the turn. People pause
        /// inside sentences; this is longer than those pauses.
        var endSilence: TimeInterval

        /// For Silero VAD probabilities.
        static let vad = Tuning(start: 0.5, keep: 0.35, minSpeech: 0.25, resume: 0.1, endSilence: 1.2)

        /// The volume threshold as it always worked: any buffer above the
        /// level is speech, and 1.2 s below it ends the turn.
        static let level = Tuning(start: 0.5, keep: 0.5, minSpeech: 0, resume: 0, endSilence: 1.2)
    }

    enum State: Equatable {
        /// Nothing said yet.
        case waiting
        /// Speech heard; the turn is open (possibly in a short pause).
        case speaking
        /// Speech, then `endSilence` of quiet: send it.
        case ended
    }

    /// RMS above which the microphone is hearing a voice rather than a
    /// room. The fallback's whole notion of speech.
    static let speechLevel: Float = 0.02

    let tuning: Tuning
    private(set) var state: State = .waiting
    /// How long the current run of speech frames has lasted.
    private var speechRun: TimeInterval = 0
    /// How long the current pause has lasted (a short burst does not
    /// reset it).
    private var silence: TimeInterval = 0

    init(_ tuning: Tuning) { self.tuning = tuning }

    /// One frame: `probability` that it is speech, `duration` it covers.
    @discardableResult
    mutating func feed(probability: Float, duration: TimeInterval) -> State {
        guard state != .ended else { return state }
        let threshold = state == .speaking && silence == 0 ? tuning.keep : tuning.start
        let speech = probability >= threshold

        switch state {
        case .waiting:
            speechRun = speech ? speechRun + duration : 0
            if speech && speechRun >= tuning.minSpeech {
                state = .speaking
                silence = 0
            }
        case .speaking:
            if speech {
                speechRun += duration
                if silence == 0 || speechRun >= tuning.resume {
                    silence = 0
                } else {
                    silence += duration
                }
            } else {
                speechRun = 0
                silence += duration
            }
            if silence >= tuning.endSilence { state = .ended }
        case .ended:
            break
        }
        return state
    }

    /// The fallback's frame: the smoothed microphone level.
    @discardableResult
    mutating func feed(level: Float, duration: TimeInterval) -> State {
        feed(probability: level > Self.speechLevel ? 1 : 0, duration: duration)
    }

    /// The microphone level after one buffer of loudness `rms`. Attack
    /// fast, release slow: a level that drops instantly makes a pause
    /// between words look like the end of a sentence.
    static func smooth(level: Float, rms: Float) -> Float {
        rms > level ? rms : level * 0.82 + rms * 0.18
    }
}
