"use client";

import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
import { formatMoney } from "@/lib/utils";
import { CHART, TOOLTIP_STYLE } from "./theme";

interface Slice {
  name: string;
  value: number;
  color: string;
}

export function CategoryDonut({
  data,
  centerLabel = "Spent",
  emptyText = "No spending this month yet.",
}: {
  data: Slice[];
  centerLabel?: string;
  emptyText?: string;
}) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[220px] text-sm text-ink-muted">
        {emptyText}
      </div>
    );
  }

  // A donut only reads as part-to-whole up to ~6 slices. Keep the six largest and fold
  // the tail into one neutral "Other" slice — the full list is on the category panel.
  // Categories outside the 8 palette slots carry the neutral colour; they always fold into
  // "Other" so the donut never shows two grey slices side by side.
  const MAX_SLICES = 6;
  const NEUTRAL = CHART.neutral;
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const named = sorted.filter((d) => d.color.toLowerCase() !== NEUTRAL).slice(0, MAX_SLICES);
  const tail = sorted.filter((d) => !named.includes(d));
  const slices: Slice[] = tail.length
    ? [...named, { name: `Other (${tail.length})`, value: tail.reduce((s, d) => s + d.value, 0), color: NEUTRAL }]
    : named;
  const total = slices.reduce((s, d) => s + d.value, 0);

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <div className="relative" style={{ width: 200, height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={62}
              outerRadius={92}
              paddingAngle={2}
              cornerRadius={4}
              stroke="#fff"
              strokeWidth={2}
            >
              {slices.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) => [
                formatMoney(Number(value ?? 0)),
                name,
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-xs font-semibold text-ink-muted">{centerLabel}</span>
          <span className="text-xl font-extrabold tracking-tight">{formatMoney(total, true)}</span>
        </div>
      </div>

      <ul className="flex-1 space-y-1.5 w-full">
        {slices.map((d) => (
          <li key={d.name} className="flex items-center gap-2 text-sm">
            <span
              className="w-3 h-3 rounded shrink-0"
              style={{ background: d.color }}
            />
            <span className="text-ink font-semibold truncate flex-1">{d.name}</span>
            <span className="text-ink font-bold tabular-nums">
              {formatMoney(d.value)}
            </span>
            <span className="text-ink-muted text-xs tabular-nums w-10 text-right">
              {Math.round((d.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
