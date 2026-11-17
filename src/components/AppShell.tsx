"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Disclaimer } from "@/components/Disclaimer";
import { usePathname, useRouter } from "next/navigation";
import {
  Menu,
  X,
  LayoutDashboard,
  ReceiptText,
  Landmark,
  Target,
  Repeat,
  PieChart,
  Tags,
  Banknote,
  LogOut,
  Scale,
  Paperclip,
  ListChecks,
  Flag,
  TrendingUp,
  ChevronDown,
  CandlestickChart,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof Menu };

const PRIMARY: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ReceiptText },
  { href: "/budgets", label: "Budgets", icon: Target },
  { href: "/reports", label: "Reports", icon: PieChart },
];

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Money",
    items: [
      { href: "/accounts", label: "Accounts", icon: Landmark },
      { href: "/balances", label: "Balances", icon: Scale },
      { href: "/net-worth", label: "Net worth", icon: TrendingUp },
      { href: "/investments", label: "Investments", icon: CandlestickChart },
      { href: "/income", label: "Income", icon: Banknote },
      { href: "/goals", label: "Goals", icon: Flag },
    ],
  },
  {
    label: "Setup",
    items: [
      { href: "/recurring", label: "Recurring", icon: Repeat },
      { href: "/receipts", label: "Receipts", icon: Paperclip },
      { href: "/categories", label: "Categories", icon: Tags },
      { href: "/rules", label: "Rules", icon: ListChecks },
    ],
  },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + "/");
}

/** One drop-down group in the top bar; closes on outside click, Escape and navigation. */
function NavGroup({ label, items, pathname }: { label: string; items: NavItem[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = items.some((i) => isActive(pathname, i.href));

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-active={active ? "true" : undefined}
        className="nav-btn"
      >
        {label}
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="menu-pop">
          {items.map(({ href, label: l, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              aria-current={isActive(pathname, href) ? "page" : undefined}
            >
              <Icon size={16} />
              {l}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // Below `lg` the menu is a drawer under the bar.
  const [navOpen, setNavOpen] = useState(false);
  const initial = (email.trim()[0] ?? "?").toUpperCase();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="app-shell min-h-screen">
      <header className="app-bar">
        <div className="app-bar-inner">
          <Link href="/dashboard" className="app-brand hover:no-underline" aria-label="SpendTrack home">
            <span className="app-brand-mark" aria-hidden="true" />
            <span>SpendTrack</span>
          </Link>

          <nav className="app-nav" aria-label="Main">
            {PRIMARY.map(({ href, label }) => (
              <Link key={href} href={href} aria-current={isActive(pathname, href) ? "page" : undefined}>
                {label}
              </Link>
            ))}
            {GROUPS.map((g) => (
              <NavGroup key={g.label} label={g.label} items={g.items} pathname={pathname} />
            ))}
          </nav>

          <div className="app-bar-end">
            <span className="app-avatar" title={email} aria-hidden="true">
              {initial}
            </span>
            <button type="button" onClick={logout} className="app-signout" aria-label="Sign out">
              <LogOut size={16} />
              <span>Sign out</span>
            </button>
            <button
              type="button"
              onClick={() => setNavOpen((o) => !o)}
              aria-expanded={navOpen}
              aria-controls="app-drawer"
              aria-label={navOpen ? "Close menu" : "Open menu"}
              className="app-burger"
            >
              {navOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>
        </div>

        {navOpen && (
          <div id="app-drawer" className="app-drawer">
            {[{ label: "Overview", items: PRIMARY }, ...GROUPS].map((g) => (
              <div key={g.label}>
                <p className="app-drawer-label">{g.label}</p>
                <div className="app-drawer-grid">
                  {g.items.map(({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setNavOpen(false)}
                      aria-current={isActive(pathname, href) ? "page" : undefined}
                    >
                      <Icon size={16} />
                      {label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            <div className="app-drawer-foot">
              <span className="truncate">{email}</span>
              <button type="button" onClick={logout} className="btn-secondary text-sm">
                <LogOut size={15} /> Sign out
              </button>
            </div>
          </div>
        )}
      </header>

      <main className="app-main">{children}</main>
      <Disclaimer />
    </div>
  );
}
