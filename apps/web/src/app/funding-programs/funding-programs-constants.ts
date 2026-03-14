/** Status badge color classes for funding program statuses. */
export const FP_STATUS_COLORS: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  closed: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  awarded: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

/** Program type display labels. */
export const PROGRAM_TYPE_LABELS: Record<string, string> = {
  rfp: "RFP",
  "grant-round": "Grant Round",
  fellowship: "Fellowship",
  prize: "Prize",
  solicitation: "Solicitation",
  call: "Call",
  fund: "Fund",
  program: "Program",
  initiative: "Initiative",
  round: "Round",
  "big-bet": "Big Bet",
  commitment: "Commitment",
};
