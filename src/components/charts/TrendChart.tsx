"use client";

import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from "recharts";
import type { TrendPoint } from "@/lib/finance";
import { formatMoney } from "@/lib/utils";
import { CHART, TOOLTIP_STYLE } from "./theme";

export function TrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
        <CartesianGrid vertical={false} stroke={CHART.grid} />
        <XAxis
          dataKey="label"
          tick={{ fill: CHART.axis, fontSize: 12 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fill: CHART.axis, fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v) => formatMoney(Number(v), true)}
        />
        <Tooltip
          cursor={{ fill: "rgba(255,107,74,0.08)" }}
          contentStyle={TOOLTIP_STYLE}
          // recharts 3: the formatter's value may be undefined for an empty slot
          formatter={(value, name) => [
            formatMoney(Number(value ?? 0)),
            name === "income" ? "Income" : "Expense",
          ]}
        />
        <Legend
          formatter={(v) => (v === "income" ? "Income" : "Expense")}
          iconType="circle"
          wrapperStyle={{ fontSize: 12, color: CHART.label, fontWeight: 600 }}
        />
        <Bar dataKey="income" fill={CHART.income} radius={[4, 4, 0, 0]} maxBarSize={22} />
        <Bar dataKey="expense" fill={CHART.expense} radius={[4, 4, 0, 0]} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}
