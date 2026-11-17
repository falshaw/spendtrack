// Chart colours for the Sunset theme. Categorical order validated (lightness band, chroma floor,
// adjacent-pair CVD separation, >= 3:1 against white) — assign in this order, never cycle.
export const CHART = {
  income: "#008a9e", // sea teal
  expense: "#e2553c", // coral
  ideal: "#7a6467", // muted ink, dashed
  grid: "rgba(38,24,27,0.08)",
  axis: "#7a6467",
  label: "#4a3438",
  neutral: "#a59c8e",
} as const;

export const CATEGORICAL = [
  "#e2553c",
  "#008a9e",
  "#b97800",
  "#7d4fb0",
  "#5a9a2c",
  "#d64f8a",
  "#2f62b8",
  "#9a5a2a",
] as const;

export const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "none",
  borderRadius: 14,
  boxShadow: "0 18px 40px -18px rgba(60,10,20,0.45)",
  color: "#26181b",
  fontSize: 12,
  fontWeight: 600,
} as const;
