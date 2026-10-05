import 'package:flutter/material.dart';

import 'api.dart';
import 'messages.dart';
import 'prefs.dart';

/// First run: the computer's address and a pairing code from
/// `agentx app pair`.
class SetupScreen extends StatefulWidget {
  const SetupScreen({super.key, required this.prefs, required this.api, required this.onPaired});

  final Prefs prefs;
  final Api api;
  final VoidCallback onPaired;

  @override
  State<SetupScreen> createState() => _SetupScreenState();
}

class _SetupScreenState extends State<SetupScreen> {
  final _address = TextEditingController();
  final _code = TextEditingController();
  String? _status;
  bool _busy = false;

  @override
  void dispose() {
    _address.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    final base = Api.normaliseAddress(_address.text);
    if (base == null) return setState(() => _status = Messages.badAddress);
    final code = Api.normaliseCode(_code.text);
    if (code == null) return setState(() => _status = Messages.badCode);
    setState(() {
      _busy = true;
      _status = 'Pairing…';
    });
    String? error;
    try {
      final token = await widget.api.pairWithCode(base, code);
      await widget.prefs.setBaseUrl(base);
      await widget.prefs.setToken(token);
      await widget.prefs.setBrowserPaired(false);
    } on HttpError catch (e) {
      error = e.message;
    } on Exception {
      error = Messages.unreachable;
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _status = error;
    });
    if (error == null) widget.onPaired();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair this phone')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            const Text(Messages.setupLead),
            const SizedBox(height: 20),
            TextField(
              controller: _address,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Computer address',
                hintText: 'computer-name.your-tailnet.ts.net',
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _code,
              autocorrect: false,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Pairing code', hintText: 'ABCD-EFGH'),
              onSubmitted: (_) => _busy ? null : _pair(),
            ),
            const SizedBox(height: 20),
            FilledButton(onPressed: _busy ? null : _pair, child: const Text('Pair')),
            if (_status != null) ...[
              const SizedBox(height: 16),
              Text(_status!, key: const Key('setup-status')),
            ],
          ],
        ),
      ),
    );
  }
}
