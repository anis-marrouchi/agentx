// Adapted from affectUI’s clean Thinking Loader (LICENSE.affectui).
const rays = Array.from({ length: 8 }, (_, index) => index)

export function ThinkingLoader() {
  return (
    <div className="axc-waiting" role="status">
      <span className="axc-waiting__spinner" aria-hidden="true">
        {rays.map((ray) => <span key={ray} style={{ rotate: `${ray * 45}deg`, animationDelay: `${(ray - 8) * 0.1}s` }} />)}
      </span>
      Waiting for the first words…
    </div>
  )
}
