// Pure helpers for the phone app's Places card (#676), shipped to the
// browser with injectFns and tested in node. Each one is self-contained.

/** What the Places card says when "Use where I am now" fails.
 *  `code` is the GeolocationPositionError code, `inShell` whether the page
 *  runs in the AgentX Android app, `permission` the geolocation permission
 *  state ("granted", "prompt", "denied", or "" when it can't be read).
 *
 *  In the Android app, Chrome asks the app for the location. If Chrome has
 *  no app registered for this address, it refuses at once (code 1) while
 *  the permission still reads "prompt". That happens after the app is
 *  reinstalled while Chrome keeps running: Chrome remembers the old
 *  registration until it restarts (#708). Only a real "denied" means the
 *  person blocked it for sure. Android's "Don't allow" can leave the state
 *  at "prompt", and the shell flag is shared with plain Chrome tabs on the
 *  same address, so the shell text names both causes. */
export function locationErrorText(code: number, inShell: boolean, permission: string): string {
  if (code !== 1) return "Could not find where you are. Try again outdoors, or type the coordinates."
  if (inShell && permission !== "denied") {
    return "The location was refused. If you tapped Don’t allow, allow location for AgentX in the phone’s settings. Otherwise Chrome hasn’t linked the AgentX app yet: Force stop Chrome once (Settings › Apps › Chrome › Force stop), then open AgentX again. Or type the coordinates."
  }
  return "Location is blocked for this app. Allow it in the phone’s settings, or type the coordinates."
}
