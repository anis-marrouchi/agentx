// #863: battery-watch.sh's four lines as a battery sensor, shared by the
// sensor tests. Kept out of the test files, so importing it registers no
// tests twice.

export const SCRIPT_LEVELS = {
  reading: "battery",
  every: "60s",
  levels: [
    { id: "on-30min", when: { forMinutes: 30 }, target: "ops-agent", brief: "Ops battery watch" },
    { id: "below-50", when: { below: 50 }, target: "ops-agent", brief: "Ops battery watch" },
    { id: "below-25", when: { below: 25 }, urgent: true, push: { from: "Ops", key: "mac-battery-low" } },
    { id: "below-15", when: { below: 15 }, target: "ops-agent", brief: "Ops battery watch, URGENT", fallbackPush: true },
  ],
  rearm: { above: 30, onAC: true },
}
