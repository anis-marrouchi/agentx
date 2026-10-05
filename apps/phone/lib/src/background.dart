import 'dart:io';
import 'dart:ui';

import 'package:workmanager/workmanager.dart';

import 'api.dart';
import 'native_fences.dart';
import 'prefs.dart';
import 'reporter.dart';
import 'sync.dart';

/// The two background jobs, through WorkManager on Android: checking for
/// changed places every app.places.syncMinutes, and sending crossings that
/// couldn't be sent at once. Both wait for a network and survive restarts.
///
/// iOS has no such scheduler without extra entitlements, so there the app
/// checks when it opens and sends what is queued at the next crossing.
class Background {
  static const _periodic = 'places-sync';
  static const _sendNow = 'places-send';
  static final _online = Constraints(networkType: NetworkType.connected);

  static bool get _supported => Platform.isAndroid;

  static Future<void> init() async {
    if (_supported) await Workmanager().initialize(backgroundDispatcher);
  }

  /// Checks every app.places.syncMinutes while place reminders are on.
  static Future<void> schedule(Prefs prefs) async {
    if (!_supported) return;
    if (!await prefs.paired || !await prefs.placesOn) {
      await Workmanager().cancelByUniqueName(_periodic);
      return;
    }
    await Workmanager().registerPeriodicTask(
      _periodic,
      _periodic,
      frequency: Duration(minutes: await prefs.syncMinutes),
      constraints: _online,
      existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
    );
  }

  /// Sends the queued crossings as soon as there is a network.
  static Future<void> sendLater() async {
    if (!_supported) return;
    try {
      await Workmanager().registerOneOffTask(
        _sendNow,
        _sendNow,
        constraints: _online,
        backoffPolicy: BackoffPolicy.exponential,
        backoffPolicyDelay: const Duration(seconds: 30),
        existingWorkPolicy: ExistingWorkPolicy.keep,
      );
    } on Exception {
      // The queue is still sent at the next check.
    }
  }

  static Future<void> cancelAll() async {
    if (_supported) await Workmanager().cancelAll();
  }
}

@pragma('vm:entry-point')
void backgroundDispatcher() {
  Workmanager().executeTask((task, _) async {
    DartPluginRegistrant.ensureInitialized();
    final prefs = Prefs();
    final api = Api();
    try {
      final sent = await Reporter(prefs, api).flush();
      if (task == Background._sendNow) return sent;
      final before = await prefs.syncMinutes;
      final ok = await PlaceSync(prefs, api, NativeFences()).sync();
      if (await prefs.syncMinutes != before) await Background.schedule(prefs);
      return ok;
    } finally {
      api.close();
    }
  });
}
