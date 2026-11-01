import WebKit

/// The answer card's web view settings (#1680).
///
/// The card page has the daemon as its base URL, so it is same-origin with
/// the daemon (`Artifacts.pageBase`). Script in that page would pass the
/// daemon's browser-origin guard, so the page runs none of its own: no
/// `<script>`, no `javascript:` link, no inline handler. The app's own
/// script (`evaluateJavaScript`, `callAsyncJavaScript`), which measures the
/// card, still runs.
enum CardWeb {
    static func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        return config
    }
}
