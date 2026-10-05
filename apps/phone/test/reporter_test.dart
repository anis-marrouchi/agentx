import 'dart:convert';
import 'dart:io';

import 'package:agentx_phone/src/api.dart';
import 'package:agentx_phone/src/messages.dart';
import 'package:agentx_phone/src/prefs.dart';
import 'package:agentx_phone/src/reporter.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'helpers.dart';

void main() {
  final now = DateTime.utc(2026, 10, 5, 8);

  Reporter reporter(Prefs prefs,Future<http.Response> Function(http.Request) handler, {DateTime? at}) =>
      Reporter(prefs, Api(client: MockClient(handler)), now: () => at ?? now);

  test('sends one report per place crossed, then empties the queue', () async {
    final prefs = await pairedPrefs();
    final sent = <Map<String, dynamic>>[];
    final r = reporter(prefs, (req) async {
      sent.add(jsonDecode(req.body) as Map<String, dynamic>);
      return http.Response('{"ok":true}', 202);
    });
    expect(await r.report(['pl_home', 'pl_school'], 'enter'), isTrue);
    expect(sent.map((e) => e['place']), ['pl_home', 'pl_school']);
    expect(sent.every((e) => e.keys.toSet().containsAll({'id', 'place', 'transition', 'time'}) && e.length == 4), isTrue);
    expect(sent.first['time'], now.millisecondsSinceEpoch);
    expect(RegExp(r'^[0-9a-f]{32}$').hasMatch(sent.first['id'] as String), isTrue);
    expect(await prefs.queued, isEmpty);
  });

  test('keeps the report while offline and sends it with the same id later', () async {
    final prefs = await pairedPrefs();
    final offline = reporter(prefs, (_) async => throw const SocketException('no network'));
    expect(await offline.report(['pl_home'], 'exit'), isFalse);
    final queued = await prefs.queued;
    expect(queued, hasLength(1));

    String? sentId;
    final online = reporter(prefs, (req) async {
      sentId = (jsonDecode(req.body) as Map)['id'] as String;
      return http.Response('{}', 202);
    });
    expect(await online.flush(), isTrue);
    expect(sentId, queued.single.id);
    expect(await prefs.queued, isEmpty);
  });

  test('retries on 5xx and 429, drops on 400/403/404', () async {
    for (final (status, kept) in [(500, 1), (503, 1), (429, 1), (400, 0), (403, 0), (404, 0)]) {
      final prefs = await pairedPrefs();
      await reporter(prefs, (_) async => http.Response('{}', status)).report(['pl_home'], 'enter');
      expect((await prefs.queued).length, kept, reason: 'HTTP $status');
    }
  });

  test('401 drops the report and says the phone is no longer paired', () async {
    final prefs = await pairedPrefs();
    await reporter(prefs, (_) async => http.Response('{}', 401)).report(['pl_home'], 'enter');
    expect(await prefs.queued, isEmpty);
    expect(await prefs.lastError, Messages.unpaired);
  });

  test('drops reports older than a day instead of retrying them', () async {
    final prefs = await pairedPrefs();
    await reporter(prefs, (_) async => throw const SocketException('x')).report(['pl_home'], 'enter');
    var calls = 0;
    final later = reporter(prefs, (_) async {
      calls++;
      return http.Response('{}', 202);
    }, at: now.add(const Duration(days: 2)));
    expect(await later.flush(), isTrue);
    expect(calls, 0);
  });

  test('sends nothing when place reminders are off on this phone', () async {
    final prefs = await pairedPrefs(placesOn: false);
    var calls = 0;
    final r = reporter(prefs, (_) async {
      calls++;
      return http.Response('{}', 202);
    });
    expect(await r.report(['pl_home'], 'enter'), isTrue);
    expect(calls, 0);
    expect(await prefs.queued, isEmpty);
  });
}
