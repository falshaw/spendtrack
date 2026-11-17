"use client";

import { useEffect } from "react";
import { Disclaimer } from "@/components/Disclaimer";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is the key into `docker logs spendtrack-app` for this failure.
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-md text-center">
        <p className="eyebrow mb-2">
          Something broke
        </p>
        <h1 className="text-2xl font-bold text-ink">This page could not load</h1>
        <p className="text-sm text-ink-muted mt-2">
          Your data is untouched — nothing was written. Try again, and if it
          keeps failing the app log has the details.
        </p>
        {error.digest && (
          <p className="text-xs text-ink-muted mt-3 font-mono">ref {error.digest}</p>
        )}
        <div className="flex items-center justify-center gap-3 mt-6">
          <button type="button" onClick={reset} className="btn-primary">
            Try again
          </button>
          <a href="/dashboard" className="btn-secondary">
            Dashboard
          </a>
        </div>
      </div>
      <Disclaimer />
    </div>
  );
}
