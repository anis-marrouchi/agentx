import 'dart:io';

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import 'background.dart';
import 'browser.dart';
import 'messages.dart';
import 'prefs.dart';
import 'sync.dart';

/// The app's home: open the phone app, and the settings for place
/// reminders. The phone app's Places card links here (agentx://places).
class PlacesScreen extends StatefulWidget {
  const PlacesScreen({super.key, required this.prefs, required this.sync, required this.onForget});

  final Prefs prefs;
  final PlaceSync sync;
  final VoidCallback onForget;

  @override
  State<PlacesScreen> createState() => _PlacesScreenState();
}

class _View {
  String? base;
  bool on = false;
  Access access = Access.none;
  bool notifications = true;
  List<String> names = const [];
  DateTime? lastSync;
  String? error;
}

class _PlacesScreenState extends State<PlacesScreen> with WidgetsBindingObserver {
  _View _v = _View();
  bool _checking = false;

  Prefs get _prefs => widget.prefs;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _refresh();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Back from the settings or the phone app: permissions may have changed.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async {
    final v = _View()
      ..base = await _prefs.baseUrl
      ..on = await _prefs.placesOn
      ..access = await widget.sync.fences.access()
      ..notifications = await _notificationsAllowed()
      ..names = await _prefs.placeNames
      ..lastSync = await _prefs.lastSyncAt
      ..error = await _prefs.lastError;
    if (mounted) setState(() => _v = v);
  }

  Future<void> _check() async {
    setState(() => _checking = true);
    await widget.sync.sync();
    await Background.schedule(_prefs);
    if (!mounted) return;
    setState(() => _checking = false);
    await _refresh();
  }

  Future<void> _turnOn() async {
    if (!await _ask('Place reminders', Messages.disclosure)) return;
    if (!await Permission.location.request().isGranted) return _denied(Messages.deniedLocation);
    if (!await Permission.locationAlways.isGranted) {
      if (!await _ask('Allow location all the time', Messages.backgroundAsk)) return _denied(Messages.deniedBackground);
      if (!await Permission.locationAlways.request().isGranted) return _denied(Messages.deniedBackground);
    }
    // Reminders arrive as the phone app's notifications, which Chrome shows
    // under this app's name (Android 13+ asks for it). Not needed to watch
    // places, so a refusal is only shown on the screen.
    if (Platform.isAndroid) await Permission.notification.request();
    await _prefs.setPlacesOn(true);
    await _check();
  }

  Future<bool> _notificationsAllowed() async => !Platform.isAndroid || await Permission.notification.isGranted;

  Future<void> _turnOff() async {
    await _prefs.setPlacesOn(false);
    await _prefs.setQueued(const []);
    await widget.sync.fences.clear();
    await _prefs.setLastError(null);
    await Background.schedule(_prefs);
    await _refresh();
  }

  Future<void> _forget() async {
    final ok = await _ask('Forget this computer?', Messages.forgetMessage, yes: 'Forget');
    if (!ok) return;
    await widget.sync.fences.clear();
    await Background.cancelAll();
    await _prefs.forget();
    widget.onForget();
  }

  Future<bool> _ask(String title, String body, {String yes = 'Continue'}) async {
    final answer = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Not now')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(yes)),
        ],
      ),
    );
    return answer ?? false;
  }

  Future<void> _denied(String body) async {
    if (!mounted) return;
    final open = await _ask('Place reminders stay off', body, yes: 'Open settings');
    if (open) await openAppSettings();
    await _refresh();
  }

  String _accessText(Access a) => switch (a) {
        Access.always => 'allowed all the time',
        Access.whileInUse => 'only while the app is open',
        Access.none => 'not allowed',
      };

  @override
  Widget build(BuildContext context) {
    final v = _v;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('AgentX')),
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: _check,
          child: ListView(
            padding: const EdgeInsets.all(20),
            children: [
              FilledButton.icon(
                onPressed: () => Browser.openApp(_prefs),
                icon: const Icon(Icons.open_in_new),
                label: const Text('Open AgentX'),
              ),
              if (v.base != null) ...[
                const SizedBox(height: 8),
                Text('Paired with ${v.base}', style: text.bodySmall),
              ],
              const SizedBox(height: 24),
              SwitchListTile(
                key: const Key('places-switch'),
                contentPadding: EdgeInsets.zero,
                title: const Text('Place reminders'),
                subtitle: const Text('Sends only which place and whether you arrived or left.'),
                value: v.on,
                onChanged: (on) => on ? _turnOn() : _turnOff(),
              ),
              Text('Location: ${_accessText(v.access)}'),
              Text('Notifications: ${v.notifications ? 'allowed' : 'not allowed. Allow them, or reminders may not show.'}'),
              const SizedBox(height: 12),
              if (!v.on)
                const Text(Messages.placesOff)
              else if (v.names.isEmpty)
                const Text(Messages.placesNone)
              else
                Text('Watching: ${v.names.join(', ')}'),
              if (v.error != null) ...[
                const SizedBox(height: 12),
                Text(v.error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              if (v.lastSync != null) ...[
                const SizedBox(height: 12),
                Text('Last checked for changes at ${TimeOfDay.fromDateTime(v.lastSync!).format(context)}.',
                    style: text.bodySmall),
              ],
              const SizedBox(height: 16),
              OutlinedButton(
                onPressed: _checking ? null : _check,
                child: Text(_checking ? 'Checking for changes…' : 'Check for new places now'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(onPressed: openAppSettings, child: const Text('Open settings for AgentX')),
              const SizedBox(height: 32),
              TextButton(onPressed: _forget, child: const Text('Forget this computer')),
            ],
          ),
        ),
      ),
    );
  }
}
