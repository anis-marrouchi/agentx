/// Words shown on the screen, kept together so they read as one voice.
/// They follow the wording of the phone app and docs/dashboard/mobile-places.md.
class Messages {
  static const unpaired =
      'This phone is no longer paired with the computer. Tap Forget this computer, then pair again.';
  static const offline = 'Could not reach the computer. Places are checked again when it is reachable.';
  static const permission =
      'Location all the time is not allowed, so no place is watched. Turn place reminders off and on again.';
  static const locationOff =
      'Location is off on this phone. Turn it on in quick settings; places are watched again at the next check.';
  static String tooMany(int max) => 'This phone watches at most $max places per app. Only the first $max are watched.';
  static String register(String detail) => 'The phone could not watch the places: $detail';

  static const setupLead =
      'On your computer, in the folder that holds agentx.json, run agentx app pair. Then type the address and the pairing code it shows.';
  static const badAddress = 'Type the address that starts with https:// (the part before /app).';
  static const badCode = 'A pairing code has 8 letters or digits, like ABCD-EFGH.';
  static const unreachable =
      'Could not reach the computer. Check that Tailscale is on, on this phone and on the computer, and try again.';

  static const disclosure =
      'AgentX uses your location in the background, even when the app is closed, to notice when you arrive at or leave the places you saved. It tells your computer only which place and whether you arrived or left. It never sends where you are.';
  static const backgroundAsk =
      'Reminders only work with the app closed if AgentX may use the location all the time. On the next screen, tap Location if needed, then choose Allow all the time and keep Use precise location on.';
  static const deniedLocation =
      "AgentX may not use this phone's precise location, so it can't notice when you arrive somewhere. To change this, open the settings for AgentX, tap Permissions, then Location, and choose Allow all the time with Use precise location on.";
  static const deniedBackground =
      'AgentX may use the location only while it is open, so reminders would not fire with the app closed. To change this, open the settings for AgentX, tap Permissions, then Location, and choose Allow all the time.';
  static const placesOff = 'Place reminders are off. This phone watches no places.';
  static const placesNone = "No places yet. Add one in the phone app's Alerts tab, or on the computer's Places page.";
  static const forgetMessage =
      'This phone stops watching places and forgets its pairing. To remove its key on the computer too, run agentx app revoke there.';
}
