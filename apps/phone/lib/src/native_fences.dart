import 'dart:io';
import 'dart:ui';

import 'package:native_geofence/native_geofence.dart' as ng;
import 'package:permission_handler/permission_handler.dart';

import 'api.dart';
import 'background.dart';
import 'prefs.dart';
import 'reporter.dart';
import 'sync.dart';

/// [Fences] on the phone itself, through the native_geofence plugin:
/// GeofencingClient (Play services) on Android, CLLocationManager on iOS.
/// No position is ever read here; the phone wakes [onCrossing] when it
/// crosses a circle.
class NativeFences implements Fences {
  static bool _ready = false;

  Future<void> _init() async {
    if (_ready) return;
    await ng.NativeGeofenceManager.instance.initialize();
    _ready = true;
  }

  /// Android lets an app watch 100 places, iOS 20.
  @override
  int get max => Platform.isIOS ? 20 : 100;

  @override
  Future<Access> access() => locationAccess();

  @override
  Future<void> clear() async {
    try {
      await _init();
      await ng.NativeGeofenceManager.instance.removeAllGeofences();
    } on Exception {
      // Nothing registered, or no Play services: nothing to stop.
    }
  }

  @override
  Future<void> watch(List<Fence> fences) async {
    if (!await Permission.location.serviceStatus.isEnabled) throw FenceError(FenceFailure.locationOff);
    try {
      await _init();
      for (final f in fences) {
        await ng.NativeGeofenceManager.instance.createGeofence(
          ng.Geofence(
            id: f.id,
            location: ng.Location(latitude: f.lat, longitude: f.lng),
            radiusMeters: f.radius,
            triggers: const {ng.GeofenceEvent.enter, ng.GeofenceEvent.exit},
            // A place the phone is already inside doesn't fire now; only a
            // real arrival or departure does.
            iosSettings: const ng.IosGeofenceSettings(initialTrigger: false),
            androidSettings: const ng.AndroidGeofenceSettings(initialTriggers: {}),
          ),
          onCrossing,
        );
      }
    } on ng.NativeGeofenceException catch (e) {
      final text = '${e.message ?? ''} ${e.details ?? ''}';
      // Play services' GeofenceStatusCodes: 1000 not available, 1001 too many.
      if (text.contains('1000') || text.contains('NOT_AVAILABLE')) throw FenceError(FenceFailure.locationOff);
      if (text.contains('1001') || text.contains('TOO_MANY')) throw FenceError(FenceFailure.tooMany);
      if (e.code == ng.NativeGeofenceErrorCode.missingBackgroundLocationPermission ||
          e.code == ng.NativeGeofenceErrorCode.missingLocationPermission) {
        throw FenceError(FenceFailure.other, 'location is not allowed all the time.');
      }
      throw FenceError(FenceFailure.other, e.message ?? e.code.name);
    }
  }
}

/// The location access the owner gave this app.
Future<Access> locationAccess() async {
  if (!await Permission.location.isGranted) return Access.none;
  if (!await Permission.locationAlways.isGranted) return Access.whileInUse;
  return Access.always;
}

/// Woken by the phone when it crosses a saved place, even with the app
/// closed. Sends which place, which way and when; nothing else.
@pragma('vm:entry-point')
Future<void> onCrossing(ng.GeofenceCallbackParams params) async {
  DartPluginRegistrant.ensureInitialized();
  final transition = switch (params.event) {
    ng.GeofenceEvent.enter => 'enter',
    ng.GeofenceEvent.exit => 'exit',
    _ => null,
  };
  if (transition == null) return;
  final api = Api();
  try {
    final sent = await Reporter(Prefs(), api).report(params.geofences.map((g) => g.id), transition);
    if (!sent) await Background.sendLater();
  } finally {
    api.close();
  }
}
