// --- One phone style set (Hub review S7, orca-design C10, C16, C25) ---
//
// The phone app (/app, app.ts) and the member and client pages (/member,
// member-styles.ts) each had their own base rules and their own copy of the
// pairing form. Both now take these. The page resets (box-sizing, html/body
// colours and font, the focus ring, reduced motion) already come from
// AX_TOKENS_CSS, so this only adds what a phone page needs on top.
//
// --link and --tick are names for existing tokens, chosen so small text keeps
// its contrast (plain blue on white is under 4.5:1).

export const PHONE_BASE_CSS = `
:root { --link: var(--ax-blue-d); --tick: var(--ax-green-d); }
[data-theme="dark"] { --link: var(--ax-blue); --tick: var(--ax-green); }
body { min-height: 100dvh; -webkit-text-size-adjust: 100%; }
code { font-family: var(--ax-mono); font-size: 0.92em; background: var(--ax-surface-3); padding: 1px 6px; border-radius: var(--ax-radius-sm); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.muted { color: var(--ax-text-2); }
`

/** The pairing and sign-in forms: /app when not paired, /member's pair,
 *  sign-in and ask-for-a-link forms. The submit button is the one primary
 *  action; other buttons in a form (Scan QR code) style themselves. The
 *  focus ring is the shared one from AX_TOKENS_CSS. */
export const PAIR_CSS = `
.pair-form { display: grid; gap: 8px; margin: 20px 0 24px; }
.pair-form label { font-weight: 600; margin-top: 8px; }
.pair-form input {
  width: 100%; min-height: 44px; padding: 8px 12px; font: inherit; font-size: 16px;
  color: var(--ax-text); background: var(--ax-surface); border: var(--ax-border-w) solid var(--ax-border-2); border-radius: var(--ax-radius-sm);
}
.pair-form input#pair-code { min-height: 56px; font: 600 24px/1.2 var(--ax-mono); letter-spacing: 0.12em; text-align: center; text-transform: uppercase; }
.pair-form input::placeholder { color: var(--ax-text-2); opacity: 0.6; }
.pair-form input:focus-visible { border-color: var(--ax-ring); }
.pair-form button {
  min-height: 44px; margin-top: 8px; padding: 0 16px; border: 0; border-radius: var(--ax-radius);
  font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
}
.pair-form button[type=submit] { color: var(--ax-primary-fg); background: var(--ax-primary); }
.pair-form button:disabled { opacity: 0.5; cursor: default; }
.pair-msg { margin: 0; min-height: 1.5em; }
.pair-msg.bad { color: var(--ax-red-ink); }
.pair-form .pair-offline {
  margin: 0; padding: 8px 12px; border-radius: var(--ax-radius-sm); font-size: var(--ax-fs-sm);
  background: var(--ax-amber-t); color: var(--ax-amber-ink); border: var(--ax-border-w) solid var(--ax-amber-e);
}
`
