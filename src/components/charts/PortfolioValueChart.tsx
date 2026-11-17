"use client";

import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { formatMoney } from "@/lib/utils";
import { CHART, TOOLTIP_STYLE } from "./theme";

export interface PortfolioPoint {
  date: string; // YYYY-MM-DD
  eur: number;
}

const DAY = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Total portfolio value over time (≈EUR, every connection summed). */
export function PortfolioValueChart({ data }: { data: PortfolioPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="pv-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.income} stopOpacity={0.28} />
            <stop offset="100%" stopColor={CHART.income} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={CHART.grid} />
        <XAxis
          dataKey="date"
          tick={{ fill: CHART.axis, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tickFormatter={(v) => DAY.format(at(String(v)))}
        />
        <YAxis
          tick={{ fill: CHART.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={64}
          domain={["auto", "auto"]}
          tickFormatter={(v) => formatMoney(Number(v), true)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(v) => LONG.format(at(String(v)))}
          formatter={(v) => [formatMoney(Number(v ?? 0)), "Portfolio value"]}
        />
        <Area type="monotone" dataKey="eur" stroke={CHART.income} strokeWidth={2} fill="url(#pv-fill)" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
