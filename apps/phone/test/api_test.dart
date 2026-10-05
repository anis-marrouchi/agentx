import 'dart:convert';

import 'package:agentx_phone/src/api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  group('normaliseAddress', () {
    test('adds https and drops the path', () {
      expect(Api.normaliseAddress(' box.example.ts.net/app '), 'https://box.example.ts.net');
      expect(Api.normaliseAddress('https://box.example.ts.net:8443/app/'), 'https://box.example.ts.net:8443');
      expect(Api.normaliseAddress('https://box.example.ts.net:443'), 'https://box.example.ts.net');
    });
    test('refuses http and empty input', () {
      expect(Api.normaliseAddress('http://box.example.ts.net'), isNull);
      expect(Api.normaliseAddress('  '), isNull);
    });
  });

  test('normaliseCode accepts any case, with or without the dash', () {
    expect(Api.normaliseCode('abcd efgh'), 'ABCD-EFGH');
    expect(Api.normaliseCode('ABCD-EFGH'), 'ABCD-EFGH');
    expect(Api.normaliseCode('ABC-DEF'), isNull);
  });

  test('tokenFromSetCookie finds the device key among other cookies', () {
    expect(Api.tokenFromSetCookie('other=1; Path=/,agentx_app=tok_123; Path=/; HttpOnly'), 'tok_123');
    expect(Api.tokenFromSetCookie('agentx_app=k; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Secure'), 'k');
    expect(Api.tokenFromSetCookie('other=1'), isNull);
    expect(Api.tokenFromSetCookie(null), isNull);
  });

  test('pairWithCode sends the code and reads the key from the cookie', () async {
    late http.Request seen;
    final api = Api(client: MockClient((req) async {
      seen = req;
      return http.Response('{"ok":true}', 200, headers: {'set-cookie': 'agentx_app=device-key; Path=/; HttpOnly'});
    }));
    expect(await api.pairWithCode('https://box', 'ABCD-EFGH'), 'device-key');
    expect(seen.url.toString(), 'https://box/api/app/pair-code');
    expect(jsonDecode(seen.body), {'code': 'ABCD-EFGH'});
  });

  test("pairWithCode shows the computer's error", () async {
    final api = Api(client: MockClient((_) async => http.Response('{"error":"That code has expired."}', 401)));
    await expectLater(
      api.pairWithCode('https://box', 'ABCD-EFGH'),
      throwsA(isA<HttpError>().having((e) => e.message, 'message', 'That code has expired.')),
    );
  });

  test('postEvent sends only id, place, transition and time, with the key', () async {
    late http.Request seen;
    final api = Api(client: MockClient((req) async {
      seen = req;
      return http.Response('{"ok":true}', 202);
    }));
    final status = await api.postEvent(
        'https://box', 'k', PlaceEvent(id: 'abcdef0123', place: 'pl_1', transition: 'enter', time: 1700000000000));
    expect(status, 202);
    expect(seen.url.path, '/api/app/places/event');
    expect(seen.headers['Authorization'], 'Bearer k');
    expect(jsonDecode(seen.body), {'id': 'abcdef0123', 'place': 'pl_1', 'transition': 'enter', 'time': 1700000000000});
  });
}
