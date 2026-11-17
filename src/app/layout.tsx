import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import "./sunset-content.css";
import "./bento.css";
import "./app-shell.css";
import "./app-hero.css";
import "./dashboard.css";

// Sunset theme: Plus Jakarta Sans for headings and body.
const sunset = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-sunset",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SpendTrack — Personal Spending Tracker",
  description:
    "Track spending, set monthly budgets, see where the money goes. Private, self-hosted.",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={sunset.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
