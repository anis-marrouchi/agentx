import Foundation
import UserNotifications

/// A desktop banner posted as AgentX Helper.
///
/// `osascript display notification` works everywhere but macOS files the
/// banner under Script Editor, with Script Editor's icon. Posting from this
/// bundle instead puts the helper's own icon — the AgentX logo unless the
/// build was given another — on the banner.
///
/// macOS takes the icon from the bundle, not from the notification, which
/// is why the icon is a build-time choice (build.sh --icon) rather than a
/// flag here.
enum Notify {

    enum Outcome: Int32 {
        case posted = 0
        /// The person has not allowed AgentX Helper to notify, or said no.
        case notAllowed = 2
        case failed = 3
    }

    /// Posts one banner and returns once macOS has accepted it. The banner
    /// then belongs to Notification Center and outlives this process.
    static func post(title: String, message: String, timeout: TimeInterval = 4) -> Outcome {
        let center = UNUserNotificationCenter.current()
        let done = DispatchSemaphore(value: 0)
        var outcome = Outcome.notAllowed

        // The first call shows macOS's "allow notifications" prompt. A
        // caller cannot wait for a person to answer it, so the timeout
        // lets the caller fall back to osascript for this one banner.
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { done.signal(); return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = message
            // No sound: agentx plays its own, at the configured volume.
            let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
            center.add(request) { error in
                outcome = error == nil ? .posted : .failed
                done.signal()
            }
        }

        // The callbacks arrive on a private queue, so blocking here is safe.
        // The semaphore also orders the write to `outcome` before the read.
        guard done.wait(timeout: .now() + timeout) == .success else { return .notAllowed }
        return outcome
    }
}
