/**
 * Coverage check for QUA-454: the tablebase mount registry must stay in
 * sync with the filesystem. This test is the regression gate that
 * prevents a new tablebase route file from being added without also
 * registering it (the exact "route file exists but never wired into
 * app.ts" drift QUA-454 exists to fix).
 */

import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { join } from "path";
import {
  TABLEBASE_MOUNTS,
  TABLEBASE_MANUAL_MOUNTS,
} from "../routes/tablebase/mount-registry.js";

// Route files that live in `routes/tablebase/` but are NOT Hono routes.
// (Constants modules, internal helpers, the registry file itself, etc.)
const NON_ROUTE_FILES = new Set<string>([
  "index.ts",
  "mount-registry.ts",
  "sync-factory.ts",
  "sync-factory.test-d.ts",
  "sync-factory-flag.ts",
  "sourcing-schema.ts",
  "audit-log.ts",
  "write-inline-verdicts.ts",
  "entity-profile-descriptions.ts",
]);

const ROUTES_DIR = join(
  new URL(".", import.meta.url).pathname,
  "..",
  "routes",
  "tablebase",
);

function listRouteFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter(
      (f) =>
        f.endsWith(".ts") &&
        !f.endsWith(".test.ts") &&
        !f.endsWith(".test-d.ts") &&
        !NON_ROUTE_FILES.has(f),
    )
    .map((f) => f.replace(/\.ts$/, ""))
    .sort();
}

/** Path "/api/foo-bar" → filename "foo-bar". */
function pathToFilename(mountPath: string): string {
  return mountPath.replace(/^\/api\//, "");
}

describe("TABLEBASE_MOUNTS registry (QUA-454)", () => {
  it("has no duplicate mount paths", () => {
    const paths = TABLEBASE_MOUNTS.map((m) => m.path);
    const unique = new Set(paths);
    expect(paths).toHaveLength(unique.size);
  });

  it("every path starts with /api/ and is kebab-case", () => {
    for (const { path } of TABLEBASE_MOUNTS) {
      expect(path).toMatch(/^\/api\/[a-z][a-z0-9-]*$/);
    }
  });

  it("every mount has a non-null route object", () => {
    for (const { path, route } of TABLEBASE_MOUNTS) {
      expect(route, `route for ${path}`).toBeDefined();
      expect(route, `route for ${path}`).not.toBeNull();
    }
  });

  it("registry + manual-mount list cover every route file on disk", () => {
    const onDisk = new Set(listRouteFiles());
    const registered = new Set(
      TABLEBASE_MOUNTS.map((m) => pathToFilename(m.path)),
    );
    const manual = new Set<string>(TABLEBASE_MANUAL_MOUNTS);

    // Routes on disk but in neither set → silent drift (QUA-454's failure mode #1)
    const missing = [...onDisk].filter(
      (f) => !registered.has(f) && !manual.has(f),
    );
    expect(missing, "route files missing from registry or manual list").toEqual([]);

    // Entries in registry or manual list but not on disk → stale reference
    const registeredOrManual = new Set([...registered, ...manual]);
    const stale = [...registeredOrManual].filter((f) => !onDisk.has(f));
    expect(stale, "registry entries pointing at nonexistent files").toEqual([]);
  });

  it("registry and manual-mount list are disjoint", () => {
    const registered = new Set(
      TABLEBASE_MOUNTS.map((m) => pathToFilename(m.path)),
    );
    const overlap = TABLEBASE_MANUAL_MOUNTS.filter((f) => registered.has(f));
    expect(overlap, "routes listed in both auto-mount and manual-mount").toEqual([]);
  });

  it("contains at least 25 auto-mounted routes (regression guard)", () => {
    // If this count drops below 25, someone probably accidentally moved
    // routes into the manual list or deleted entries. Adjust only if you
    // truly added an exclusion — and then update this number AND the
    // mount-registry.ts header comment.
    expect(TABLEBASE_MOUNTS.length).toBeGreaterThanOrEqual(25);
  });
});
