import 'api.dart';
import 'messages.dart';
import 'prefs.dart';

/// How much location access the owner gave this app.
enum Access { none, whileInUse, always }

/// One saved place to watch: a circle around a point.
class Fence {
  const Fence({required this.id, required this.name, required this.lat, required this.lng, required this.radius});
  final String id;
  final String name;
  final double lat;
  final double lng;
  final double radius;
}

/// Why the phone refused to watch the places.
enum FenceFailure { locationOff, tooMany, other }

class FenceError implements Exception {
  FenceError(this.kind, [this.detail = '']);
  final FenceFailure kind;
  final String detail;
}

/// The phone's own geofencing (Play services on Android, Core Location on
/// iOS). The phone, not this app, watches the places and wakes the app on a
/// crossing, even with the app closed and the screen off.
abstract class Fences {
  /// The most places this phone lets one app watch.
  int get max;
  Future<Access> access();
  Future<void> clear();

  /// Throws [FenceError].
  Future<void> watch(List<Fence> fences);
}

/// Fetches the places from the computer and asks the phone to watch them.
class PlaceSync {
  PlaceSync(this.prefs, this.api, this.fences, {DateTime Function()? now}) : _now = now ?? DateTime.now;

  final Prefs prefs;
  final Api api;
  final Fences fences;
  final DateTime Function() _now;

  /// Returns false when it should be tried again later.
  Future<bool> sync() async {
    final base = await prefs.baseUrl;
    final token = await prefs.token;
    if (base == null || token == null) return true;

    final Map<String, dynamic> body;
    try {
      body = await api.getPlaces(base, token);
    } on HttpError catch (e) {
      if (e.status == 401) {
        await prefs.setLastError(Messages.unpaired);
        await fences.clear();
        return true;
      }
      await prefs.setLastError(e.message);
      return false;
    } on Exception {
      await prefs.setLastError(Messages.offline);
      return false;
    }

    final minutes = body['syncMinutes'];
    await prefs.setSyncMinutes(minutes is num ? minutes.toInt().clamp(15, 1440) : 60);
    final all = parseFences(body['places']);
    final list = all.take(fences.max).toList();
    await prefs.setPlaceNames([for (final f in list) f.name]);
    await prefs.setLastSyncAt(_now());

    final enabled = body['enabled'] == true;
    final placesOn = await prefs.placesOn;
    final access = await fences.access();
    await fences.clear();
    if (!enabled || !placesOn || access != Access.always || list.isEmpty) {
      String? error;
      if (!enabled) {
        final reason = body['reason'];
        error = reason is String && reason.isNotEmpty ? reason : null;
      } else if (placesOn && access != Access.always) {
        error = Messages.permission;
      }
      await prefs.setLastError(error);
      return true;
    }
    try {
      await fences.watch(list);
      await prefs.setLastError(all.length > list.length ? Messages.tooMany(fences.max) : null);
      return true;
    } on FenceError catch (e) {
      await prefs.setLastError(switch (e.kind) {
        FenceFailure.locationOff => Messages.locationOff,
        FenceFailure.tooMany => Messages.tooMany(fences.max),
        FenceFailure.other => Messages.register(e.detail),
      });
      return e.kind != FenceFailure.tooMany;
    }
  }

  /// Turns the places in GET /api/app/places into fences, skipping any it
  /// can't read.
  static List<Fence> parseFences(Object? places) {
    if (places is! List) return const [];
    final out = <Fence>[];
    for (final p in places) {
      if (p is! Map) continue;
      final id = p['id'], lat = p['lat'], lng = p['lng'], radius = p['radius'];
      if (id is! String || id.isEmpty || lat is! num || lng is! num || radius is! num || radius <= 0) continue;
      final name = p['name'];
      out.add(Fence(
        id: id,
        name: name is String && name.isNotEmpty ? name : id,
        lat: lat.toDouble(),
        lng: lng.toDouble(),
        radius: radius.toDouble(),
      ));
    }
    return out;
  }
}
