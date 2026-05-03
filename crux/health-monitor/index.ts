/**
 * Health Monitor — re-exports for the command handler & tests.
 */

export {
  buildConfig,
  fetchCiSnapshot,
  fetchHealthSnapshot,
  getDaemonStatus,
  runCycle,
  runDaemon,
  DEFAULT_CONFIG,
} from './daemon.ts';
export { evaluateCiStale, evaluateJobsStuck } from './signals.ts';
export type {
  Alert,
  CiSnapshot,
  DaemonConfig,
  HealthSnapshot,
  SignalId,
} from './types.ts';
