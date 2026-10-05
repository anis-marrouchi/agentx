import 'dart:convert';
import 'dart:io';

import 'package:agentx_phone/src/api.dart';
import 'package:agentx_phone/src/messages.dart';
import 'package:agentx_phone/src/prefs.dart';
import 'package:agentx_phone/src/sync.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers.dart';

Map<String, dynamic> placesBody({bool enabled = true, List<Map<String, dynamic>>? places, int syncMinutes = 30}) => {
      'enabled': enabled,
      'reason': enabled ? null : 'Place reminders are off on this computer (app.places.enabled).',
      'syncMinutes': syncMinutes,
      'places': places ??
          [
            {'id': 'pl_home', 'name': 'Home', 'lat': 36.8, 'lng': 10.18, 'radius': 150},
            {'id': 'pl_school', 'name': 'School', 'lat': 36.81, 'lng': 10.19, 'radius': 200},
          ],
      'rules': [],
    };

PlaceSync placeSync(Prefs prefs, FakeFences fences, Future<http.Response> Function(http.Request) handler) =>
    PlaceSync(prefs, Api(client: MockClient(handler)), fences);

http.Response ok(Map<String, dynamic> body) => http.Response(jsonEncode(body), 200);

void main() {
  test('watches every saved place and remembers the names and check interval', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences();
    expect(await placeSync(prefs, fences, (_) async => ok(placesBody())).sync(), isTrue);
    expect(fences.watching.map((f) => f.id), ['pl_home', 'pl_school']);
    expect(fences.watching.first.radius, 150);
    expect(await prefs.placeNames, ['Home', 'School']);
    expect(await prefs.syncMinutes, 30);
    expect(await prefs.lastError, isNull);
  });

  test('watches nothing while the switch on this phone is off', () async {
    final prefs = await pairedPrefs(placesOn: false);
    final fences = FakeFences();
    await placeSync(prefs, fences, (_) async => ok(placesBody())).sync();
    expect(fences.watching, isEmpty);
    expect(fences.clears, 1);
    expect(await prefs.lastError, isNull);
  });

  test('watches nothing and says why without location all the time', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences(granted: Access.whileInUse);
    await placeSync(prefs, fences, (_) async => ok(placesBody())).sync();
    expect(fences.watching, isEmpty);
    expect(await prefs.placeNames, isEmpty);
    expect(await prefs.lastError, Messages.permission);
  });

  test('switched off while the computer answered: stops watching again', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences()..onWatch = () => prefs.setPlacesOn(false);
    await placeSync(prefs, fences, (_) async => ok(placesBody())).sync();
    expect(fences.watching, isEmpty);
    expect(await prefs.placeNames, isEmpty);
  });

  test("shows the computer's reason when it has place reminders off", () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences();
    await placeSync(prefs, fences, (_) async => ok(placesBody(enabled: false))).sync();
    expect(fences.watching, isEmpty);
    expect(await prefs.lastError, contains('app.places.enabled'));
  });

  test('watches only as many places as the phone allows, and says so', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences(max: 1);
    await placeSync(prefs, fences, (_) async => ok(placesBody())).sync();
    expect(fences.watching.map((f) => f.id), ['pl_home']);
    expect(await prefs.lastError, Messages.tooMany(1));
  });

  test('a revoked key stops watching', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences()..watching = [const Fence(id: 'x', name: 'x', lat: 0, lng: 0, radius: 100)];
    expect(await placeSync(prefs, fences, (_) async => http.Response('{"error":"unauthorized"}', 401)).sync(), isTrue);
    expect(fences.watching, isEmpty);
    expect(await prefs.placeNames, isEmpty);
    expect(await prefs.lastError, Messages.unpaired);
  });

  test('offline: keeps watching what it had and asks to be tried again', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences();
    expect(await placeSync(prefs, fences, (_) async => throw const SocketException('down')).sync(), isFalse);
    expect(fences.clears, 0);
    expect(await prefs.lastError, Messages.offline);
  });

  test('location turned off on the phone is reported in plain words', () async {
    final prefs = await pairedPrefs();
    final fences = FakeFences(failure: FenceError(FenceFailure.locationOff));
    expect(await placeSync(prefs, fences, (_) async => ok(placesBody())).sync(), isTrue);
    expect(await prefs.lastError, Messages.locationOff);
  });

  test('parseFences skips places it cannot read', () {
    final fences = PlaceSync.parseFences([
      {'id': 'a', 'lat': 1, 'lng': 2, 'radius': 100},
      {'id': '', 'lat': 1, 'lng': 2, 'radius': 100},
      {'id': 'b', 'lat': '1', 'lng': 2, 'radius': 100},
      {'id': 'c', 'lat': 1, 'lng': 2, 'radius': 0},
      'junk',
    ]);
    expect(fences.map((f) => f.id), ['a']);
    expect(fences.single.name, 'a');
    expect(PlaceSync.parseFences(null), isEmpty);
  });

  test('clamps the check interval to 15 minutes – 1 day', () async {
    final prefs = await pairedPrefs();
    await placeSync(prefs, FakeFences(), (_) async => ok(placesBody(syncMinutes: 1))).sync();
    expect(await prefs.syncMinutes, 15);
  });
}
