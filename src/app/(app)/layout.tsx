import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";
import { maybeRefreshEcb } from "@/lib/fx";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Fire-and-forget: tops fx_rates up when it is > 3 business days behind. Never
  // awaited (a slow ECB must not hold a page) and never throws.
  void maybeRefreshEcb();

  return <AppShell email={session.email}>{children}</AppShell>;
}
