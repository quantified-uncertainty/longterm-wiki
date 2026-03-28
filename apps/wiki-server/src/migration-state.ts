/**
 * Global migration state — tracks whether the server started with a migration failure.
 *
 * When migrations fail, the server starts in degraded mode instead of crash-looping.
 * The health endpoint reads this state to report "degraded" status with the error
 * message, giving operators visibility without requiring kubectl access.
 *
 * This is a simple module-level variable, not a class or singleton, because:
 * - It's set once at startup and read many times
 * - There's exactly one server process per pod
 * - No concurrency concerns (single-threaded Node.js)
 */

let migrationError: string | null = null;

export function setMigrationError(error: string): void {
  migrationError = error;
}

export function getMigrationError(): string | null {
  return migrationError;
}
