/**
 * Per-route feature flag for the TableBase sync handler factory rollout.
 *
 * Provides instant per-route rollback during Phase 2+ of the factory migration.
 * Read by routes that have BOTH a factory implementation and a legacy handler
 * coexisting during the 7-day soak period after migration.
 *
 * Discussion #4088, issue #4090.
 *
 * ## Behavior
 *
 * The `USE_SYNC_FACTORY_ROUTES` env var controls which routes use the factory:
 *
 * | Env value                   | Effect                                      |
 * |-----------------------------|---------------------------------------------|
 * | (unset) or empty            | Factory ON for all routes (default)         |
 * | `*`                         | Factory ON for all routes (explicit)        |
 * | `personnel,divisions`       | Factory ON only for those routes; others fall back to legacy |
 * | `!political-scores`         | Factory ON for all routes EXCEPT political-scores            |
 * | `!a,!b,!c`                  | Factory ON for all routes EXCEPT a, b, c                     |
 *
 * The exclusion mode (`!routeName`) is the primary use case during migration:
 * if a route breaks after factory adoption, operators set
 * `USE_SYNC_FACTORY_ROUTES=!broken-route` to immediately fall back to the
 * legacy handler without redeploying.
 *
 * ## Migration pattern
 *
 * Phase 2 migration PRs follow this pattern:
 *
 * ```typescript
 * import { useFactoryFor } from "./sync-factory-flag.js";
 *
 * const myApp = new Hono()
 *   .post("/sync", async (c) => {
 *     if (useFactoryFor("my-route")) {
 *       return factoryHandler(c);
 *     }
 *     return legacyHandler(c);
 *   });
 *
 * const factoryHandler = createSyncHandler({ ... });
 * const legacyHandler = async (c: Context) => { ... };
 * ```
 *
 * After 7 days of clean metrics, a separate PR removes the legacy handler
 * and the conditional, leaving only the factory call.
 *
 * ## Testing
 *
 * The flag is cached after the first call. Tests must call `_resetFlagCache()`
 * in `beforeEach` to pick up `vi.stubEnv("USE_SYNC_FACTORY_ROUTES", "...")`
 * changes.
 */

const FLAG_ENV = "USE_SYNC_FACTORY_ROUTES";

let cached: Set<string> | null = null;

function parseFlag(): Set<string> {
  if (cached) return cached;
  const raw = process.env[FLAG_ENV] ?? "";
  cached = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return cached;
}

/**
 * Returns true if the named route should use the factory implementation.
 * Returns false if the route should fall back to its legacy handler.
 *
 * @param routeName - The route name (e.g. "personnel", "divisions"). Must
 *   match the `name` field in the route's `createSyncHandler` config.
 */
export function useFactoryFor(routeName: string): boolean {
  const flag = parseFlag();

  // Default (no env var set) → factory ON for all
  if (flag.size === 0) return true;

  // Wildcard → factory ON for all
  if (flag.has("*")) return true;

  // Explicit exclusion → factory OFF for this route
  if (flag.has(`!${routeName}`)) return false;

  // Check if the flag is in exclusion mode (any "!"-prefixed entries)
  const hasExclusions = [...flag].some((s) => s.startsWith("!"));
  if (hasExclusions) {
    // Exclusion mode: ON for all routes not explicitly excluded
    return true;
  }

  // Inclusion mode: ON only for explicitly listed routes
  return flag.has(routeName);
}

/**
 * Reset the cached flag value. Tests must call this in `beforeEach` after
 * stubbing `process.env.USE_SYNC_FACTORY_ROUTES` to pick up the new value.
 */
export function _resetFlagCache(): void {
  cached = null;
}
