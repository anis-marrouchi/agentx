import 'dart:math';

import 'api.dart';
import 'messages.dart';
import 'prefs.dart';

/// Sends crossings to the computer. A crossing is queued first, so one that
/// can't be sent now (no network, computer asleep) is sent at the next try:
/// the next crossing, the next check (app.places.syncMinutes) or the next
/// time the app opens.
class Reporter {
  Reporter(this.prefs, this.api, {DateTime Function()? now, Random? random})
      : _now = now ?? DateTime.now,
        _random = random ?? Random.secure();

  final Prefs prefs;
  final Api api;
  final DateTime Function() _now;
  final Random _random;

  /// The computer drops old reports anyway (app.places.maxEventAgeMinutes);
  /// stop retrying one that can only be dropped.
  static const maxAge = Duration(days: 1);

  /// Queues one report per place crossed, then tries to send the queue.
  /// Returns true when nothing is left to send.
  Future<bool> report(Iterable<String> placeIds, String transition) async {
    if (!await prefs.placesOn) return true;
    final time = _now().millisecondsSinceEpoch;
    final queue = await prefs.queued;
    for (final place in placeIds) {
      queue.add(PlaceEvent(id: newId(), place: place, transition: transition, time: time));
    }
    await prefs.setQueued(queue);
    return flush();
  }

  /// Sends what is queued, oldest first. Returns true when nothing is left.
  Future<bool> flush() async {
    final queue = await prefs.queued;
    if (queue.isEmpty) return true;
    final base = await prefs.baseUrl;
    final token = await prefs.token;
    // Unpaired, or turned off since the crossing: drop everything.
    if (base == null || token == null || !await prefs.placesOn) {
      await prefs.setQueued(const []);
      return true;
    }
    // Ids sent or dropped for good. The geofence callback and the background
    // job run apart, so a crossing may be queued while this one posts: the
    // queue is read again at the end and only these are taken out of it.
    final done = <String>{};
    final now = _now().millisecondsSinceEpoch;
    for (final event in queue) {
      if (now - event.time > maxAge.inMilliseconds) {
        done.add(event.id);
        continue;
      }
      try {
        final status = await api.postEvent(base, token, event);
        if (status == 429 || status >= 500) continue;
        // 2xx: sent. 400, 403, 404 and the rest: refused for good, don't retry.
        done.add(event.id);
        if (status == 401) await prefs.setLastError(Messages.unpaired);
      } on Exception {
        // No network, a timeout, the computer asleep: the rest would fail
        // too, so try them all again later.
        break;
      }
    }
    final left = [for (final e in await prefs.queued) if (!done.contains(e.id)) e];
    await prefs.setQueued(left);
    return left.isEmpty;
  }

  /// 32 random hex digits: matches the computer's 8–64 letters, digits, - or _.
  String newId() => List.generate(16, (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}
