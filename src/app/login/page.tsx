"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, PieChart, Target, ShieldCheck } from "lucide-react";
import { Disclaimer } from "@/components/Disclaimer";

const POINTS = [
  { icon: FileUp, title: "Import statements", text: "CSV and PDF statements, checked against their printed totals." },
  { icon: PieChart, title: "See where it goes", text: "Categories, trends and a cash-flow map of every month." },
  { icon: Target, title: "Budgets that warn", text: "Monthly caps with a burn chart, before the month runs out." },
  { icon: ShieldCheck, title: "Stays on your machine", text: "Self-hosted with Docker; nothing leaves your network." },
];

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Login failed");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="sun-auth min-h-screen flex flex-col items-center px-4 pt-12 pb-10 sm:pt-16">
      <div className="text-center mb-8">
        <div className="app-brand sun-auth-brand text-3xl sm:text-4xl">
          <span className="app-brand-mark" aria-hidden="true" />
          <h1 className="text-inherit">SpendTrack</h1>
        </div>
        <p className="sun-auth-tagline mt-3 text-base sm:text-lg font-semibold">
          Where the money goes, month by month. Self-hosted, private.
        </p>
      </div>

      <div className="sun-auth-grid">
        <form onSubmit={handleSubmit} className="glass-card p-6 sm:p-8 space-y-4">
          <div>
            <p className="eyebrow">Welcome back</p>
            <h2 className="text-2xl mt-1">Sign in</h2>
          </div>
          {error && (
            <p className="text-sm text-clay-deep bg-clay/10 rounded-xl p-3 font-semibold" role="alert">
              {error}
            </p>
          )}

          <div>
            <label htmlFor="login-email" className="block text-sm text-ink-soft mb-1.5">Email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="you@example.com"
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm text-ink-soft mb-1.5">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input-field"
              autoComplete="current-password"
              required
            />
          </div>
          <button type="submit" className="btn-primary w-full py-3" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div className="sun-auth-panel">
          <p className="eyebrow">What you get</p>
          <ul className="mt-4 space-y-4">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3">
                <span className="sun-auth-icon">
                  <Icon size={18} />
                </span>
                <span>
                  <span className="block font-extrabold text-ink">{title}</span>
                  <span className="block text-sm text-ink-muted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Disclaimer className="mt-auto pt-10 pb-0" />
    </div>
  );
}
