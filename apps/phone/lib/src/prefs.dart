import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// What the app remembers, in app-private storage. Android backups are off
/// for this app (android:allowBackup="false"), so the key never leaves the
/// phone.
///
/// The token is this phone's device key from `agentx app pair`: the same
/// kind of key the phone app keeps in its cookie. It only opens /app and
/// /api/app on the paired computer, and `agentx app revoke` cancels it.
///
/// Reads always go to storage (SharedPreferencesAsync), because the geofence
/// and background jobs run in their own isolates and may have written since.
class Prefs {
  Prefs([SharedPreferencesAsync? store]) : _p = store ?? SharedPreferencesAsync();

  final SharedPreferencesAsync _p;

  /// The most crossings kept while the phone is offline.
  static const maxQueued = 50;

  Future<String?> get baseUrl => _p.getString('baseUrl');
  Future<void> setBaseUrl(String v) => _p.setString('baseUrl', v);

  Future<String?> get token => _p.getString('token');
  Future<void> setToken(String v) => _p.setString('token', v);

  Future<bool> get paired async => (await baseUrl) != null && (await token) != null;

  /// The browser has been handed the key once (through /app/pair).
  Future<bool> get browserPaired async => await _p.getBool('browserPaired') ?? false;
  Future<void> setBrowserPaired(bool v) => _p.setBool('browserPaired', v);

  /// The owner's switch for place reminders on this phone. Off by default.
  Future<bool> get placesOn async => await _p.getBool('placesOn') ?? false;
  Future<void> setPlacesOn(bool v) => _p.setBool('placesOn', v);

  /// Names of the places registered at the last check, for the screen.
  Future<List<String>> get placeNames async => await _p.getStringList('placeNames') ?? const [];
  Future<void> setPlaceNames(List<String> v) => _p.setStringList('placeNames', v);

  Future<DateTime?> get lastSyncAt async {
    final ms = await _p.getInt('lastSyncAt');
    return ms == null ? null : DateTime.fromMillisecondsSinceEpoch(ms);
  }

  Future<void> setLastSyncAt(DateTime v) => _p.setInt('lastSyncAt', v.millisecondsSinceEpoch);

  /// Plain words for the screen, or null when the last check went well.
  Future<String?> get lastError => _p.getString('lastError');
  Future<void> setLastError(String? v) => v == null ? _p.remove('lastError') : _p.setString('lastError', v);

  /// app.places.syncMinutes from the computer.
  Future<int> get syncMinutes async => await _p.getInt('syncMinutes') ?? 60;
  Future<void> setSyncMinutes(int v) => _p.setInt('syncMinutes', v);

  /// Crossings not sent yet, oldest first.
  Future<List<PlaceEvent>> get queued async {
    final raw = await _p.getStringList('queue') ?? const [];
    return [
      for (final s in raw)
        if (_decode(s) case final PlaceEvent e) e,
    ];
  }

  Future<void> setQueued(List<PlaceEvent> events) {
    final keep = events.length > maxQueued ? events.sublist(events.length - maxQueued) : events;
    return _p.setStringList('queue', [for (final e in keep) jsonEncode(e.toJson())]);
  }

  /// Forgets the computer, the key and everything else.
  Future<void> forget() => _p.clear();

  static PlaceEvent? _decode(String s) {
    try {
      return PlaceEvent.fromJson(jsonDecode(s));
    } catch (_) {
      return null;
    }
  }
}
