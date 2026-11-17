import Link from "next/link";
import { Disclaimer } from "@/components/Disclaimer";

export default function NotFound() {
  return (
    <div className="sun-auth min-h-screen flex flex-col items-center justify-center p-4">
      <div className="glass-card p-8 w-full max-w-md text-center">
        <p className="eyebrow mb-2">404</p>
        <h1 className="text-2xl font-bold text-ink">No such page</h1>
        <p className="text-sm text-ink-muted mt-2">
          That address is not part of SpendTrack.
        </p>
        <Link href="/dashboard" className="btn-primary mt-6">
          Back to the dashboard
        </Link>
      </div>
      <Disclaimer />
    </div>
  );
}
