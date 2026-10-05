import 'package:flutter/material.dart';

import 'src/api.dart';
import 'src/background.dart';
import 'src/browser.dart';
import 'src/native_fences.dart';
import 'src/places_screen.dart';
import 'src/prefs.dart';
import 'src/reporter.dart';
import 'src/setup_screen.dart';
import 'src/sync.dart';

/// The AgentX phone shell (#676). It opens the phone app (/app) unchanged in
/// the phone's browser, and adds what a web page can't have: the phone's own
/// geofencing, so a place reminder fires with the app closed.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Background.init();
  final prefs = Prefs();
  final api = Api();
  final sync = PlaceSync(prefs, api, NativeFences());
  final paired = await prefs.paired;
  // From the launcher, a paired phone goes straight to the phone app; the
  // phone app's Places card opens agentx://places, which stays here.
  final link = await Browser.launchLink();
  if (paired && link == null) await Browser.openApp(prefs);
  if (paired && await prefs.placesOn) {
    // Fire and forget: the screen shows the result when it is ready.
    () async {
      await Reporter(prefs, api).flush();
      await sync.sync();
      await Background.schedule(prefs);
    }();
  }
  runApp(AgentXApp(prefs: prefs, api: api, sync: sync, paired: paired));
}

class AgentXApp extends StatefulWidget {
  const AgentXApp({super.key, required this.prefs, required this.api, required this.sync, required this.paired});

  final Prefs prefs;
  final Api api;
  final PlaceSync sync;
  final bool paired;

  @override
  State<AgentXApp> createState() => _AgentXAppState();
}

class _AgentXAppState extends State<AgentXApp> {
  late bool _paired = widget.paired;

  @override
  Widget build(BuildContext context) {
    const brand = Color(0xFF2979FF);
    return MaterialApp(
      title: 'AgentX',
      theme: ThemeData(colorSchemeSeed: brand),
      darkTheme: ThemeData(colorSchemeSeed: brand, brightness: Brightness.dark),
      home: _paired
          ? PlacesScreen(prefs: widget.prefs, sync: widget.sync, onForget: () => setState(() => _paired = false))
          : SetupScreen(
              prefs: widget.prefs,
              api: widget.api,
              onPaired: () async {
                setState(() => _paired = true);
                await Browser.openApp(widget.prefs);
              },
            ),
    );
  }
}
