import 'dart:convert';

import 'package:http/http.dart' as http;

/// An answer from the computer that wasn't a success.
class HttpError implements Exception {
  HttpError(this.status, this.message);
  final int status;
  final String message;
  @override
  String toString() => message;
}

/// Plain HTTPS calls to the paired computer's /api/app routes: the same
/// routes the phone app uses, behind the same device key.
class Api {
  Api({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;
  static const _cookie = 'agentx_app';
  static const _timeout = Duration(seconds: 20);

  /// Normalises what the owner typed: https only, host and port, no path,
  /// no trailing slash. Null when it isn't a usable address.
  static String? normaliseAddress(String input) {
    var s = input.trim();
    if (s.isEmpty) return null;
    if (!s.contains('://')) s = 'https://$s';
    final uri = Uri.tryParse(s);
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) return null;
    final port = uri.hasPort && uri.port != 443 ? ':${uri.port}' : '';
    return 'https://${uri.host}$port';
  }

  /// Same form as the phone app's field: capitals and the dash are optional.
  /// Returns ABCD-EFGH, or null when it isn't 8 letters or digits.
  static String? normaliseCode(String input) {
    final raw = input.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');
    if (raw.length != 8) return null;
    return '${raw.substring(0, 4)}-${raw.substring(4)}';
  }

  /// Trades a pairing code from `agentx app pair` for this phone's device
  /// key. The computer answers with the key in its session cookie, the same
  /// one the phone app gets; it is read from that header.
  Future<String> pairWithCode(String base, String code) async {
    final res = await _client
        .post(Uri.parse('$base/api/app/pair-code'),
            headers: _headers(null, json: true), body: jsonEncode({'code': code}))
        .timeout(_timeout);
    if (res.statusCode != 200) throw HttpError(res.statusCode, _errorText(res));
    final token = tokenFromSetCookie(res.headers['set-cookie']);
    if (token == null) throw HttpError(res.statusCode, 'The computer accepted the code but sent no key.');
    return token;
  }

  /// The places, reminders and limits for this phone.
  Future<Map<String, dynamic>> getPlaces(String base, String token) async {
    final res = await _client.get(Uri.parse('$base/api/app/places'), headers: _headers(token)).timeout(_timeout);
    if (res.statusCode != 200) throw HttpError(res.statusCode, _errorText(res));
    final body = jsonDecode(res.body);
    if (body is! Map<String, dynamic>) throw HttpError(res.statusCode, 'The computer sent an answer this app does not understand.');
    return body;
  }

  /// Sends one crossing. Returns the HTTP status.
  Future<int> postEvent(String base, String token, PlaceEvent event) async {
    final res = await _client
        .post(Uri.parse('$base/api/app/places/event'),
            headers: _headers(token, json: true), body: jsonEncode(event.toJson()))
        .timeout(_timeout);
    return res.statusCode;
  }

  void close() => _client.close();

  static Map<String, String> _headers(String? token, {bool json = false}) => {
        'Accept': 'application/json',
        if (json) 'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  /// Finds the device key in a Set-Cookie header. package:http joins several
  /// Set-Cookie headers with commas, so each part is checked.
  static String? tokenFromSetCookie(String? header) {
    if (header == null) return null;
    for (final part in header.split(RegExp(r',(?=\s*[A-Za-z0-9_\-]+=)'))) {
      final first = part.split(';').first;
      final eq = first.indexOf('=');
      if (eq < 0) continue;
      if (first.substring(0, eq).trim() != _cookie) continue;
      final value = first.substring(eq + 1).trim();
      if (value.isNotEmpty) return value;
    }
    return null;
  }

  static String _errorText(http.Response res) {
    try {
      final body = jsonDecode(res.body);
      if (body is Map && body['error'] is String && (body['error'] as String).isNotEmpty) return body['error'] as String;
    } catch (_) {
      // Not JSON: fall through to the status line.
    }
    return 'The computer answered HTTP ${res.statusCode}.';
  }
}

/// One crossing of a saved place: which place, which way, when. This is
/// everything the phone ever sends about where it is.
class PlaceEvent {
  PlaceEvent({required this.id, required this.place, required this.transition, required this.time});

  /// Random, so a report sent twice fires once on the computer.
  final String id;
  final String place;

  /// `enter` or `exit`.
  final String transition;

  /// Milliseconds since 1970 (UTC).
  final int time;

  Map<String, dynamic> toJson() => {'id': id, 'place': place, 'transition': transition, 'time': time};

  static PlaceEvent? fromJson(Object? json) {
    if (json is! Map) return null;
    final id = json['id'], place = json['place'], transition = json['transition'], time = json['time'];
    if (id is! String || place is! String || transition is! String || time is! int) return null;
    return PlaceEvent(id: id, place: place, transition: transition, time: time);
  }
}
