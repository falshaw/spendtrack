"use client";

import { DISCLAIMER_TEXT } from "@/components/Disclaimer";

// Replaces the root layout when the layout itself throws, so it cannot rely on
// globals.css or the font variables — literal theme values, inline.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#fff8f1",
          color: "#26181b",
          fontFamily: '"Segoe UI", system-ui, sans-serif',
        }}
      >
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #f2e3d6",
            borderRadius: 18,
            padding: 32,
            maxWidth: 420,
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: 22, margin: 0 }}>SpendTrack could not start this page</h1>
          <p style={{ fontSize: 14, color: "#7a6467", marginTop: 8 }}>
            Your data is untouched. Try again; the app log has the details.
          </p>
          {error.digest && (
            <p style={{ fontSize: 12, color: "#7a6467", fontFamily: "monospace" }}>
              ref {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: "10px 22px",
              borderRadius: 9999,
              border: "none",
              background: "#26181b",
              color: "#ffffff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
        <p style={{ fontSize: 12, color: "#7a6467", textAlign: "center", padding: "24px 16px", margin: 0 }}>
          {DISCLAIMER_TEXT}
        </p>
      </body>
    </html>
  );
}
