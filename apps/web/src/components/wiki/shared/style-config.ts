export const severityColors = {
  low: { hex: "#22c55e" },
  medium: { hex: "#eab308" },
  "medium-high": { hex: "#f59e0b" },
  high: { hex: "#f97316" },
  catastrophic: { hex: "#dc2626" },
  critical: { hex: "#dc2626" },
} as const;

export const directionColors = {
  higher: { icon: "\u25b2", color: "#10b981" },
  lower: { icon: "\u25bc", color: "#3b82f6" },
  context: { icon: "\u25c6", color: "#f59e0b" },
} as const;

export const maturityColors = {
  neglected: { hex: "#ef4444" },
  emerging: { hex: "#f59e0b" },
  growing: { hex: "#3b82f6" },
  mature: { hex: "#16a34a" },
  established: { hex: "#22c55e" },
} as const;

export const riskCategoryColors = {
  accident: { hex: "#f59e0b" },
  misuse: { hex: "#ef4444" },
  structural: { hex: "#6366f1" },
  epistemic: { hex: "#a855f7" },
} as const;
