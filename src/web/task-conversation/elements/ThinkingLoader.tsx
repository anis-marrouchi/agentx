// Adapted from affectUI's clean Thinking Loader (src/daemon/ui/LICENSE.affectui).
// Styles: the shared .ax-af-loader in src/daemon/ui/affect.css.ts.
const rays = Array.from({ length: 8 }, (_, index) => index)

export function ThinkingLoader() {
  return (
    <div className="ax-af-loader axc-waiting" role="status">
      <span className="ax-af-loader__rays" aria-hidden="true">
        {rays.map((ray) => <span key={ray} style={{ rotate: `${ray * 45}deg`, animationDelay: `${(ray - 8) * 0.1}s` }} />)}
      </span>
      Waiting for the first words…
    </div>
  )
}
