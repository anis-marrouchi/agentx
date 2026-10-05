import 'package:agentx_phone/src/prefs.dart';
import 'package:agentx_phone/src/sync.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';

/// Fresh, empty storage for each test.
Prefs memoryPrefs() {
  SharedPreferencesAsyncPlatform.instance = InMemorySharedPreferencesAsync.empty();
  return Prefs();
}

Future<Prefs> pairedPrefs({bool placesOn = true}) async {
  final prefs = memoryPrefs();
  await prefs.setBaseUrl('https://box.example.ts.net');
  await prefs.setToken('device-key');
  await prefs.setPlacesOn(placesOn);
  return prefs;
}

/// Records what the app asked the phone to watch.
class FakeFences implements Fences {
  FakeFences({this.granted = Access.always, this.max = 100, this.failure});

  Access granted;
  @override
  final int max;
  FenceError? failure;
  List<Fence> watching = [];
  int clears = 0;

  @override
  Future<Access> access() async => granted;

  @override
  Future<void> clear() async {
    clears++;
    watching = [];
  }

  @override
  Future<void> watch(List<Fence> fences) async {
    if (failure != null) throw failure!;
    watching = fences;
  }
}
