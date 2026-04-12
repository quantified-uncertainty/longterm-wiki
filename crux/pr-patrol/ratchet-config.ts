/**
 * PR Patrol — Ratchet baseline registry (QUA-299 Phase 2).
 *
 * Ratchet files lock in a count (violations, stubs, etc.) and can only move
 * in one "good" direction. The ratchet-drift scanner flags when the same
 * baseline is bumped N times in M hours, which usually means downstream
 * agents are silencing CI instead of fixing the underlying cause.
 *
 * This file is the single place to register new ratchets. Adding a baseline
 * here makes it subject to the drift scan — no other wiring is needed.
 */

export interface RatchetConfig {
  /** Path relative to the git repo root. */
  file: string;
  /**
   * Human-readable name for escalation messages, e.g. "sourcing rename
   * ratchet". Kept short because it appears in patrol queue reasons.
   */
  name: string;
  /**
   * JSON property inside the baseline file whose value is the enforced
   * total. Nested paths like `"route.total"` are not supported today —
   * baselines in this repo are flat objects.
   */
  totalField: string;
  /**
   * Which direction counts as "bad". If `up`, an increasing total is drift
   * (the usual case — more violations slipping in). If `down`, a decreasing
   * total is drift (rare — e.g., a coverage ratchet going backwards).
   */
  badDirection: 'up' | 'down';
}

/**
 * Baselines subject to drift scanning.
 *
 * Keep this list small. A file belongs here only if:
 *   1. It has a single numeric field that represents enforced total
 *   2. Legitimate changes move it in one direction only
 *   3. Repeated bumps in the bad direction are a red flag, not routine
 */
export const RATCHET_BASELINES: readonly RatchetConfig[] = [
  {
    file: 'crux/validate/.sourcing-baseline.json',
    name: 'sourcing rename',
    totalField: 'total',
    badDirection: 'up',
  },
];
