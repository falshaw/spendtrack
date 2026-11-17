"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { PacePoint } from "@/lib/finance";
import { formatMoney } from "@/lib/utils";
import { CHART, TOOLTIP_STYLE } from "./theme";

export function PaceChart({ data }: { data: PacePoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={230}>
      <AreaChart data={data} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="paceFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART.expense} stopOpacity={0.32} />
            <stop offset="100%" stopColor={CHART.expense} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={CHART.grid} />
        <XAxis
          dataKey="day"
          tick={{ fill: CHART.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          interval={4}
        />
        <YAxis
          tick={{ fill: CHART.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={(v) => formatMoney(Number(v), true)}
        />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(l) => `Day ${l}`}
          formatter={(value, name) => [
            formatMoney(Number(value ?? 0)),
            name === "ideal" ? "On-pace target" : "Actual spend",
          ]}
        />
        <Legend
          iconType="circle"
          formatter={(v) => (v === "ideal" ? "Even pace to budget" : "Actual spend")}
          wrapperStyle={{ fontSize: 12, color: CHART.label, fontWeight: 600 }}
        />
        <Line
          type="monotone"
          dataKey="ideal"
          stroke={CHART.ideal}
          strokeWidth={1.5}
          strokeDasharray="5 4"
          dot={false}
          connectNulls
        />
        <Area
          type="monotone"
          dataKey="actual"
          stroke={CHART.expense}
          strokeWidth={2}
          fill="url(#paceFill)"
          dot={false}
          activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
          connectNulls
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
