import { describe, it, expect } from "vitest";
import { runValidation } from "../validate-rendered-sid.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempDataDir() {
  const base = mkdtempSync(join(tmpdir(), "rendered-sid-test-"));
  return base;
}

function writeJson(dir: string, filename: string, data: unknown) {
  writeFileSync(join(dir, filename), JSON.stringify(data));
}

describe("validate-rendered-sid", () => {
  it("passes when no sid_ values in display positions", () => {
    const dataDir = makeTempDataDir();

    writeJson(dataDir, "database.json", {
      typedEntities: [
        { id: "alice", stableId: "sid_AAAAAAAAAA", title: "Alice Smith", description: "A person" },
        { id: "acme", stableId: "sid_BBBBBBBBBB", title: "Acme Corp", description: "A company" },
      ],
    });

    writeJson(dataDir, "factbase-data.json", {
      facts: {
        sid_BBBBBBBBBB: [
          { id: "f_test", propertyId: "founded-date", value: { type: "text", value: "2020" } },
        ],
      },
    });

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(true);
    expect(result.leaks).toHaveLength(0);
  });

  it("detects bare sid_ in entity title", () => {
    const dataDir = makeTempDataDir();

    writeJson(dataDir, "database.json", {
      typedEntities: [
        { id: "broken", stableId: "sid_CCCCCCCCCC", title: "sid_CCCCCCCCCC" },
      ],
    });

    writeJson(dataDir, "factbase-data.json", { facts: {} });

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(false);
    expect(result.leaks).toHaveLength(1);
    expect(result.leaks[0].field).toBe("title");
    expect(result.leaks[0].value).toBe("sid_CCCCCCCCCC");
  });

  it("detects bare sid_ in entity description", () => {
    const dataDir = makeTempDataDir();

    writeJson(dataDir, "database.json", {
      typedEntities: [
        { id: "broken", stableId: "sid_DDDDDDDDDD", title: "Good Title", description: "sid_DDDDDDDDDD" },
      ],
    });

    writeJson(dataDir, "factbase-data.json", { facts: {} });

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(false);
    expect(result.leaks).toHaveLength(1);
    expect(result.leaks[0].field).toBe("description");
  });

  it("detects sid_ in record displayName", () => {
    const dataDir = makeTempDataDir();

    writeJson(dataDir, "database.json", { typedEntities: [] });

    writeJson(dataDir, "factbase-data.json", {
      facts: {},
      records: {
        sid_BBBBBBBBBB: {
          "board-seats": [
            {
              key: "member-1",
              schema: "board-seats",
              ownerEntityId: "sid_BBBBBBBBBB",
              displayName: "sid_EEEEEEEEEE",
              fields: { member: "sid_EEEEEEEEEE", role: "Board Member" },
            },
          ],
        },
      },
    });

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(false);
    expect(result.leaks).toHaveLength(1);
    expect(result.leaks[0].field).toBe("displayName");
  });

  it("detects bare sid_ in fact text values", () => {
    const dataDir = makeTempDataDir();

    writeJson(dataDir, "database.json", { typedEntities: [] });

    writeJson(dataDir, "factbase-data.json", {
      facts: {
        sid_BBBBBBBBBB: [
          {
            id: "f_broken",
            propertyId: "board-member",
            value: { type: "text", value: "sid_FFFFFFFFFF" },
          },
        ],
      },
    });

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(false);
    expect(result.leaks).toHaveLength(1);
    expect(result.leaks[0].field).toBe("value.value");
  });

  it("does not flag sid_ in legitimate ref-type fact values", () => {
    const dataDir = makeTempDataDir();

    writeJson(dataDir, "database.json", { typedEntities: [] });

    writeJson(dataDir, "factbase-data.json", {
      facts: {
        sid_BBBBBBBBBB: [
          {
            id: "f_ref",
            propertyId: "founded-by",
            value: { type: "ref", value: "sid_AAAAAAAAAA" },
          },
        ],
      },
    });

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(true);
    expect(result.leaks).toHaveLength(0);
  });

  it("handles missing data files gracefully", () => {
    const dataDir = makeTempDataDir();
    // No files written — should not crash

    const result = runValidation({ dataDir });
    expect(result.passed).toBe(true);
    expect(result.stats.entitiesChecked).toBe(0);
  });
});
