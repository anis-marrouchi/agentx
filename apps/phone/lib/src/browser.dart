import 'dart:io';

import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'prefs.dart';

/// Opens the phone app (/app), unchanged, in the phone's browser.
///
/// On Android it runs in Chrome as a Trusted Web Activity (MainActivity.kt),
/// so cookies, camera, microphone and Web Push all keep working; a WebView
/// inside this app would have no Web Push. Chrome shows it full screen when
/// the computer vouches for this app (app.android.certFingerprints).
/// On iOS it opens in Safari; add it to the Home Screen there for push.
class Browser {
  static const _channel = MethodChannel('agentx/shell');

  /// The first time, the browser gets the key through /app/pair#token=…:
  /// the part after # never reaches the network, and the page swaps it for
  /// its cookie and opens /app. One pairing code covers both.
  static Future<void> openApp(Prefs prefs) async {
    final base = await prefs.baseUrl;
    if (base == null) return;
    final token = await prefs.token;
    final first = token != null && !await prefs.browserPaired;
    final url = first ? '$base/app/pair#token=${Uri.encodeComponent(token)}' : '$base/app';
    await open(url);
    if (first) await prefs.setBrowserPaired(true);
  }

  static Future<void> open(String url) async {
    if (Platform.isAndroid) {
      try {
        await _channel.invokeMethod<void>('openTrusted', {'url': url});
        return;
      } on PlatformException {
        // No browser that supports it: fall back to a plain browser tab.
      }
    }
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  /// The link the app was opened with, such as agentx://places from the
  /// phone app's Places card. Null from the launcher.
  static Future<String?> launchLink() async {
    if (!Platform.isAndroid) return null;
    try {
      return await _channel.invokeMethod<String>('launchLink');
    } on PlatformException {
      return null;
    }
  }
}
