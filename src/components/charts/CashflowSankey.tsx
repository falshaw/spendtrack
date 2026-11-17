"use client";

import { ResponsiveContainer, Sankey, Tooltip, type SankeyNodeProps, type SankeyLinkProps } from "recharts";
import type { SankeyData } from "@/lib/sankey";
import { formatMoney } from "@/lib/utils";
import { CHART, TOOLTIP_STYLE } from "./theme";

/**
 * F6 — where the money went: income sources → Income → groups → top categories,
 * with "Saved" (or "From savings") closing the balance. Data from `buildSankey`.
 */
export function CashflowSankey({ data }: { data: SankeyData }) {
  if (data.links.length === 0) {
    return <p className="text-sm text-ink-muted">No income or spending in this window.</p>;
  }

  function Node(props: SankeyNodeProps) {
    const { x, y, width, height, index, payload } = props;
    const n = data.nodes[index];
    const value = (payload as { value?: number }).value ?? 0;
    // Labels on the right of every column except the last, which labels to its left.
    const right = n.kind === "source" || n.kind === "savings" || n.kind === "hub" || n.kind === "group";
    return (
      <g>
        <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={n.color} rx={3} />
        {height >= 9 && (
          <text
            x={right ? x + width + 6 : x - 6}
            y={y + height / 2}
            textAnchor={right ? "start" : "end"}
            dominantBaseline="middle"
            fontSize={11}
            fill={CHART.label}
            fontWeight={600}
          >
            {n.name} · {formatMoney(value, true)}
          </text>
        )}
      </g>
    );
  }

  function Link(props: SankeyLinkProps) {
    const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, index } = props;
    const l = data.links[index];
    const color = data.nodes[l.target].kind === "saved" ? data.nodes[l.target].color : data.nodes[l.source].color;
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={color}
        strokeOpacity={0.28}
        strokeWidth={Math.max(linkWidth, 1)}
      />
    );
  }

  const height = Math.max(320, Math.min(640, data.nodes.length * 30));
  return (
    <div data-testid="cashflow-sankey">
      {/* On a phone the four columns + labels need ~640 px: scroll sideways instead of overlapping labels. */}
      <div className="overflow-x-auto -mx-2 px-2">
      <div className="min-w-[640px]">
      <ResponsiveContainer width="100%" height={height}>
        <Sankey
          data={{ nodes: data.nodes.map((n) => ({ name: n.name })), links: data.links }}
          node={Node}
          link={Link}
          nodePadding={14}
          nodeWidth={10}
          margin={{ top: 8, right: 150, bottom: 8, left: 8 }}
          iterations={32}
        >
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value) => formatMoney(Number(value ?? 0))}
          />
        </Sankey>
      </ResponsiveContainer>
      </div>
      </div>
      <p className="text-xs text-ink-muted mt-2 tabular-nums">
        Income {formatMoney(data.income)} · spent {formatMoney(data.spend)} ·{" "}
        {data.saved > 0 ? `saved ${formatMoney(data.saved)}` : `drawn from savings ${formatMoney(data.fromSavings)}`}
        {data.netted > 0 && ` · ${formatMoney(data.netted)} of net refunds not drawn`}
      </p>
    </div>
  );
}
