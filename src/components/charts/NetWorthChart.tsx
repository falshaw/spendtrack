"use client";

import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { formatMoney } from "@/lib/utils";
import { CHART, TOOLTIP_STYLE } from "./theme";

export interface NetWorthPoint {
  label: string;
  net: number;
  netAfterReserve: number | null;
  estimated: boolean;
}

/** F1 — net worth per month (stored snapshots), with the after-reserve line beside it. */
export function NetWorthChart({ data }: { data: NetWorthPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke={CHART.grid} />
        <XAxis dataKey="label" tick={{ fill: CHART.axis, fontSize: 12 }} tickLine={false} axisLine={false} />
        <YAxis
          tick={{ fill: CHART.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={64}
          tickFormatter={(v) => formatMoney(Number(v), true)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={(v, name) => [v == null ? "—" : formatMoney(Number(v), true), name]}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 12, color: CHART.label, fontWeight: 600 }} />
        <Line type="monotone" dataKey="net" name="Net worth" stroke={CHART.income} strokeWidth={2} dot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: CHART.income }} />
        <Line type="monotone" dataKey="netAfterReserve" name="After tax reserve" stroke={CHART.expense} strokeWidth={2} strokeDasharray="4 3" dot={{ r: 4, stroke: "#fff", strokeWidth: 2, fill: CHART.expense }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}
