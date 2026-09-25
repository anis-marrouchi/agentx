import CoreAudio
import Darwin
import Foundation

/// When a spoken line has ended, as heard rather than as reported.
///
/// `say` can go quiet and never exit: on 2026-09-25 one sat for eight
/// minutes after its Siri line, holding the speaker lock. Waiting for the
/// process kept the line scrolling in the widget long after the voice
/// stopped, and queued every later line, the daemon's too, behind it.
///
/// So a line has ended once its process was heard playing audio and has
/// been silent for `quiet` seconds since. Before its first sound (waiting
/// for the speaker lock, starting up) nothing ends it.
struct SpeechEnd {
    var quiet: TimeInterval = 0.3
    private var heard = false
    private var quietSince: Date?

    init(quiet: TimeInterval = 0.3) { self.quiet = quiet }

    /// One poll: is the line's process playing audio right now.
    mutating func ended(playing: Bool, at now: Date) -> Bool {
        if playing { heard = true; quietSince = nil; return false }
        guard heard else { return false }
        let since = quietSince ?? now
        quietSince = since
        return now.timeIntervalSince(since) >= quiet
    }
}

enum AudioOutput {
    /// True when `pid`, or a child of it (the script's `say`), is playing
    /// audio. Core Audio's per-process view; another process's speech is
    /// not visible to NSSpeechSynthesizer.isAnyApplicationSpeaking.
    static func playing(pid: pid_t) -> Bool {
        let pids = Set([pid] + children(of: pid))
        return processObjects().contains { obj in
            value(obj, kAudioProcessPropertyIsRunningOutput, UInt32(0)) != 0
                && pids.contains(value(obj, kAudioProcessPropertyPID, pid_t(0)))
        }
    }

    private static func children(of pid: pid_t) -> [pid_t] {
        var buf = [pid_t](repeating: 0, count: 16)
        let n = proc_listchildpids(pid, &buf, Int32(buf.count * MemoryLayout<pid_t>.size))
        return n > 0 ? Array(buf.prefix(Int(n))) : []
    }

    private static func processObjects() -> [AudioObjectID] {
        var addr = address(kAudioHardwarePropertyProcessObjectList)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func value<T: FixedWidthInteger>(_ obj: AudioObjectID, _ selector: AudioObjectPropertySelector, _ fallback: T) -> T {
        var addr = address(selector)
        var v = fallback
        var size = UInt32(MemoryLayout<T>.size)
        return AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, &v) == noErr ? v : fallback
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                   mElement: kAudioObjectPropertyElementMain)
    }
}
