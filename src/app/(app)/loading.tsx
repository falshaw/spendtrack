// Every (app) page is force-dynamic and queries Postgres, so navigation used to
// sit on the old page with no feedback until the new one had fully rendered.
export default function Loading() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="app-hero app-hero-skeleton" aria-hidden="true">
        <div className="h-4 w-28 rounded-full bg-white/30" />
        <div className="mt-4 h-10 w-64 rounded-xl bg-white/40" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="glass-card h-24" />
        ))}
      </div>
      <div className="glass-card h-72" />
    </div>
  );
}
