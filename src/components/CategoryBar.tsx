import { formatMoney, cn } from "@/lib/utils";
import type { CategorySlice } from "@/lib/finance";

/** Colour the bar by spend pace: green on-track, orange near cap, red over. */
function paceColor(pct: number | null): string {
  if (pct == null) return "#a59c8e";
  if (pct >= 1) return "#c8401f";
  if (pct >= 0.8) return "#b97800";
  return "#5f7a3c";
}

export function CategoryBar({ slice }: { slice: CategorySlice }) {
  const { name, spent, budget, pct } = slice;
  const fill = pct == null ? 0 : Math.min(pct, 1) * 100;
  const over = pct != null && pct > 1;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1 text-sm">
        <span className="text-ink-soft truncate">{name}</span>
        <span className="tabular-nums text-ink-soft">
          {formatMoney(spent)}
          {budget != null && (
            <span className="text-ink-muted"> / {formatMoney(budget)}</span>
          )}
        </span>
      </div>
      <div className="h-2 rounded-full bg-ink/[0.04] overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${budget == null ? 0 : fill}%`,
            background: paceColor(pct),
          }}
        />
      </div>
      {budget != null && (
        <div className="mt-1 flex justify-between text-xs">
          <span className={cn(over ? "text-clay-deep" : "text-ink-muted")}>
            {over
              ? `${formatMoney(spent - budget)} over`
              : `${formatMoney(budget - spent)} left`}
          </span>
          {pct != null && (
            <span className="text-ink-muted tabular-nums">
              {Math.round(pct * 100)}%
            </span>
          )}
        </div>
      )}
      {budget == null && (
        <div className="mt-1 text-xs text-ink-muted">No budget set</div>
      )}
    </div>
  );
}
