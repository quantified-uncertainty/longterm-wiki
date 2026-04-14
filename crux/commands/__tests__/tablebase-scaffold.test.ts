import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Unit tests for validation helpers (pure functions). For the integration
// test of the full scaffold flow against a temp project root, we re-export
// the command function directly and CD the process before running it.
import { commands } from "../tablebase-scaffold.ts";

// ── Setup: a temp "project root" with stub registry files ─────────────

let tmpRoot: string;
let originalCwd: string;

const STUB_TABLE_REGISTRY = `export const TABLE_CONFIGS: Record<string, unknown> = {
  existing: {
    syncPath: '/api/existing/sync',
  },
};
`;

const STUB_MOUNT_REGISTRY = `import { existingRoute } from "./existing.js";

export const TABLEBASE_MOUNTS = [
  { path: "/api/existing", route: existingRoute },
];
`;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "scaffold-test-"));

  // Minimal file tree mirroring the real paths the scaffold writes to.
  mkdirSync(join(tmpRoot, "apps/wiki-server/src/routes/tablebase"), { recursive: true });
  mkdirSync(join(tmpRoot, "crux/lib/wiki-server"), { recursive: true });
  mkdirSync(join(tmpRoot, "crux/tablebase"), { recursive: true });

  writeFileSync(
    join(tmpRoot, "crux/tablebase/table-registry.ts"),
    STUB_TABLE_REGISTRY,
    "utf-8",
  );
  writeFileSync(
    join(tmpRoot, "apps/wiki-server/src/routes/tablebase/mount-registry.ts"),
    STUB_MOUNT_REGISTRY,
    "utf-8",
  );

  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("tablebase scaffold (QUA-455)", () => {
  describe("name validation", () => {
    it("rejects empty name", async () => {
      const result = await commands.scaffold([], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Usage");
    });

    it("rejects non-kebab-case", async () => {
      const result = await commands.scaffold(["MyTable"], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("kebab-case");
    });

    it("rejects name starting with digit", async () => {
      const result = await commands.scaffold(["2things"], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("kebab-case");
    });

    it("rejects consecutive hyphens", async () => {
      const result = await commands.scaffold(["foo--bar"], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("consecutive hyphens");
    });

    it("rejects too-short name", async () => {
      const result = await commands.scaffold(["ab"], {});
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("at least 3");
    });

    it("accepts valid kebab-case name", async () => {
      const result = await commands.scaffold(["my-table"], { "dry-run": true });
      expect(result.exitCode).toBe(0);
    });
  });

  describe("dry-run mode", () => {
    it("does not write any files when --dry-run is set", async () => {
      const result = await commands.scaffold(["new-thing"], { "dry-run": true });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("dry run");
      expect(
        existsSync(join(tmpRoot, "apps/wiki-server/src/routes/tablebase/new-thing.ts")),
      ).toBe(false);
      expect(existsSync(join(tmpRoot, "crux/lib/wiki-server/new-thing.ts"))).toBe(false);
      // Registries untouched
      expect(
        readFileSync(join(tmpRoot, "crux/tablebase/table-registry.ts"), "utf-8"),
      ).toBe(STUB_TABLE_REGISTRY);
    });
  });

  describe("happy path", () => {
    it("creates route file, client, and updates both registries", async () => {
      const result = await commands.scaffold(["new-thing"], {});
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Next steps");

      // Route file
      const routeFile = readFileSync(
        join(tmpRoot, "apps/wiki-server/src/routes/tablebase/new-thing.ts"),
        "utf-8",
      );
      expect(routeFile).toContain("newThingApp");
      expect(routeFile).toContain("SyncNewThingItemSchema");
      expect(routeFile).toContain("export const newThingRoute");
      expect(routeFile).toContain("export type NewThingRoute");
      expect(routeFile).toContain("TODO");

      // Client
      const clientFile = readFileSync(
        join(tmpRoot, "crux/lib/wiki-server/new-thing.ts"),
        "utf-8",
      );
      expect(clientFile).toContain("getAllNewThing");
      expect(clientFile).toContain("syncNewThing");
      expect(clientFile).toContain("NewThingSyncResult");

      // Table registry
      const tableRegistry = readFileSync(
        join(tmpRoot, "crux/tablebase/table-registry.ts"),
        "utf-8",
      );
      expect(tableRegistry).toContain("'new-thing':");
      expect(tableRegistry).toContain("/api/new-thing/sync");
      expect(tableRegistry).toContain("'new_thing'"); // snake case thingsSourceTable
      // The pre-existing entry is still there
      expect(tableRegistry).toContain("existing:");

      // Mount registry
      const mountRegistry = readFileSync(
        join(tmpRoot, "apps/wiki-server/src/routes/tablebase/mount-registry.ts"),
        "utf-8",
      );
      expect(mountRegistry).toContain(
        'import { newThingRoute } from "./new-thing.js";',
      );
      expect(mountRegistry).toContain(
        '{ path: "/api/new-thing", route: newThingRoute },',
      );
      // The pre-existing import is still there
      expect(mountRegistry).toContain("existingRoute");
    });
  });

  describe("collisions", () => {
    it("aborts if route file already exists", async () => {
      // First run creates the file
      const first = await commands.scaffold(["collide"], {});
      expect(first.exitCode).toBe(0);

      // Second run should error out
      const second = await commands.scaffold(["collide"], {});
      expect(second.exitCode).toBe(1);
      expect(second.output).toContain("already exists");
    });

    it("--force overwrites existing files", async () => {
      const first = await commands.scaffold(["collide-force"], {});
      expect(first.exitCode).toBe(0);

      const second = await commands.scaffold(["collide-force"], { force: true });
      expect(second.exitCode).toBe(0);
    });
  });

  describe("registry idempotence", () => {
    it("skips registry inserts on second run (does not double-add)", async () => {
      await commands.scaffold(["idempotent"], {});
      const firstRegistry = readFileSync(
        join(tmpRoot, "crux/tablebase/table-registry.ts"),
        "utf-8",
      );

      // Second run with --force should re-write files but leave registries alone
      await commands.scaffold(["idempotent"], { force: true });
      const secondRegistry = readFileSync(
        join(tmpRoot, "crux/tablebase/table-registry.ts"),
        "utf-8",
      );

      expect(secondRegistry).toBe(firstRegistry);
      // Only one entry for "idempotent"
      const matches = secondRegistry.match(/'idempotent':/g) ?? [];
      expect(matches).toHaveLength(1);
    });
  });

  describe("name conversions in generated output", () => {
    it("converts multi-word kebab to PascalCase, camelCase, and snake_case", async () => {
      await commands.scaffold(["multi-word-name"], {});
      const routeFile = readFileSync(
        join(tmpRoot, "apps/wiki-server/src/routes/tablebase/multi-word-name.ts"),
        "utf-8",
      );
      expect(routeFile).toContain("multiWordNameApp");
      expect(routeFile).toContain("SyncMultiWordNameItemSchema");
      expect(routeFile).toContain("MultiWordNameRoute");
      expect(routeFile).toContain('"multi_word_name"'); // snake case

      const tableRegistry = readFileSync(
        join(tmpRoot, "crux/tablebase/table-registry.ts"),
        "utf-8",
      );
      expect(tableRegistry).toContain("'multi-word-name':");
      expect(tableRegistry).toContain("'multi_word_name'"); // thingsSourceTable
    });
  });
});
