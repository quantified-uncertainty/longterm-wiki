/**
 * Worker --types arg guard.
 *
 * Validates that every entry in the worker's --types CLI arg has a matching
 * handler in the job-handler registry. Used to fail-fast at startup so a
 * job-type rename in code that misses ops/k8s/.../values.yaml is caught at
 * deploy time (ArgoCD CrashLoop) instead of silently piling up unconsumed
 * jobs in the queue.
 *
 * Background: QUA-699 (claim-verification → claim-sourcing) and QUA-1039
 * were the same bug — registry renamed, k8s args stale. The previous warn
 * loop at run.ts:579 surfaced nothing visible until prod debugging.
 */

export class WorkerTypesGuardError extends Error {
  readonly unknown: string[];
  readonly registered: string[];

  constructor(unknown: string[], registered: string[]) {
    super(
      `[worker] Configured --types includes ${unknown.length} unknown ` +
        `type(s) with no registered handler: ${unknown.join(', ')}. ` +
        `This usually means a job-type rename in code that wasn't mirrored ` +
        `in ops/k8s/apps/longterm-wiki-worker/values.yaml (--types arg). ` +
        `Known handler types: ${registered.join(', ')}`,
    );
    this.name = 'WorkerTypesGuardError';
    this.unknown = unknown;
    this.registered = registered;
  }
}

/**
 * Throws WorkerTypesGuardError if any configured type is missing from the
 * registered handler set. An empty `configured` list means "claim any type"
 * and is intentionally not validated.
 */
export function assertConfiguredTypesAreRegistered(
  configured: string[],
  registered: string[],
): void {
  if (configured.length === 0) return;
  const registeredSet = new Set(registered);
  const unknown = configured.filter((t) => !registeredSet.has(t));
  if (unknown.length > 0) {
    throw new WorkerTypesGuardError(unknown, registered);
  }
}
