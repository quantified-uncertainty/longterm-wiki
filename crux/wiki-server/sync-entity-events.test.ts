import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadEventsFile,
  loadAllEvents,
  eventIdFor,
  VALID_EVENT_TYPES,
  VALID_SIGNIFICANCE,
} from "./sync-entity-events.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "entity-events-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, contents: string): string {
  const p = join(tmp, name);
  writeFileSync(p, contents);
  return p;
}

describe("eventIdFor", () => {
  it("produces a deterministic 10-char ID", () => {
    const id = eventIdFor("sid_abc1234567", "2020-12", "Founded");
    expect(id).toHaveLength(10);
    expect(eventIdFor("sid_abc1234567", "2020-12", "Founded")).toBe(id);
  });

  it("produces different IDs for different inputs", () => {
    const a = eventIdFor("sid_abc1234567", "2020-12", "Founded");
    const b = eventIdFor("sid_abc1234567", "2020-12", "Acquired");
    const c = eventIdFor("sid_xyz9876543", "2020-12", "Founded");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("differentiates date variants", () => {
    expect(eventIdFor("sid_abc1234567", "2020", "X")).not.toBe(
      eventIdFor("sid_abc1234567", "2020-12", "X"),
    );
  });
});

describe("loadEventsFile", () => {
  const validYaml = `
entityId: sid_abc1234567
entityDisplayName: Test Org
events:
  - date: "2020-12"
    title: Founded
    eventType: founding
    significance: major
    description: Test event
    source: https://example.com
  - date: "2021"
    title: Series A
    eventType: funding
`;

  it("parses a valid file", () => {
    const f = writeFile("test.yaml", validYaml);
    const events = loadEventsFile(f);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      entityId: "sid_abc1234567",
      entityDisplayName: "Test Org",
      date: "2020-12",
      title: "Founded",
      eventType: "founding",
      significance: "major",
      description: "Test event",
      source: "https://example.com",
      notes: null,
    });
    expect(events[0].id).toHaveLength(10);
  });

  it("defaults significance/description/source/notes to null when absent", () => {
    const f = writeFile("t.yaml", validYaml);
    const events = loadEventsFile(f);
    expect(events[1].significance).toBeNull();
    expect(events[1].description).toBeNull();
    expect(events[1].source).toBeNull();
    expect(events[1].notes).toBeNull();
  });

  it("produces deterministic IDs across calls", () => {
    const f = writeFile("t.yaml", validYaml);
    const a = loadEventsFile(f);
    const b = loadEventsFile(f);
    expect(a[0].id).toBe(b[0].id);
    expect(a[1].id).toBe(b[1].id);
  });

  it("accepts YYYY, YYYY-MM, and YYYY-MM-DD dates", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events:
  - { date: "2020", title: A, eventType: founding }
  - { date: "2020-12", title: B, eventType: founding }
  - { date: "2020-12-15", title: C, eventType: founding }
`,
    );
    const events = loadEventsFile(f);
    expect(events.map((e) => e.date)).toEqual(["2020", "2020-12", "2020-12-15"]);
  });

  it("rejects invalid date formats", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events:
  - { date: "Dec 2020", title: X, eventType: founding }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/date.*YYYY/);
  });

  it("rejects unknown event types", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events:
  - { date: "2020", title: X, eventType: bogus }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/eventType/);
  });

  it("rejects unknown significance levels", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events:
  - { date: "2020", title: X, eventType: founding, significance: huge }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/significance/);
  });

  it("rejects empty title", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events:
  - { date: "2020", title: "", eventType: founding }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/title/);
  });

  it("rejects missing entityId", () => {
    const f = writeFile(
      "t.yaml",
      `
events:
  - { date: "2020", title: X, eventType: founding }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/entityId/);
  });

  it("rejects events that is not an array", () => {
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events: "oops"
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/events.*array/);
  });

  it("rejects non-object top-level YAML", () => {
    const f = writeFile("t.yaml", `- foo`);
    expect(() => loadEventsFile(f)).toThrow(/object/);
  });

  it("rejects null/primitive items in the events array", () => {
    // Regression for pre-existing bug: the events loader used to cast the
    // raw item to RawEvent without a runtime shape check, so a null or
    // primitive array entry would crash later with a bare TypeError.
    const f = writeFile(
      "t.yaml",
      `
entityId: sid_abc1234567
events:
  - null
  - { date: "2020", title: OK, eventType: founding }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/events\[0\].*must be an object/);
  });

  it("includes the file path in error messages", () => {
    const f = writeFile(
      "broken.yaml",
      `
entityId: sid_abc1234567
events:
  - { date: "X", title: X, eventType: founding }
`,
    );
    expect(() => loadEventsFile(f)).toThrow(/broken\.yaml/);
  });

  it("accepts every documented event type", () => {
    for (const t of VALID_EVENT_TYPES) {
      const f = writeFile(
        `${t}.yaml`,
        `
entityId: sid_abc1234567
events:
  - { date: "2020", title: T, eventType: ${t} }
`,
      );
      expect(loadEventsFile(f)[0].eventType).toBe(t);
    }
  });

  it("accepts every documented significance level", () => {
    for (const s of VALID_SIGNIFICANCE) {
      const f = writeFile(
        `${s}.yaml`,
        `
entityId: sid_abc1234567
events:
  - { date: "2020", title: T, eventType: founding, significance: ${s} }
`,
      );
      expect(loadEventsFile(f)[0].significance).toBe(s);
    }
  });
});

describe("loadAllEvents", () => {
  it("returns empty when directory does not exist", () => {
    const result = loadAllEvents(join(tmp, "missing"));
    expect(result.events).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it("aggregates events across multiple files", () => {
    writeFile(
      "a.yaml",
      `
entityId: sid_aaaaaaa111
events:
  - { date: "2020", title: A1, eventType: founding }
  - { date: "2021", title: A2, eventType: launch }
`,
    );
    writeFile(
      "b.yaml",
      `
entityId: sid_bbbbbbb222
events:
  - { date: "2020", title: B1, eventType: founding }
`,
    );
    const result = loadAllEvents(tmp);
    expect(result.files).toEqual(["a.yaml", "b.yaml"]);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.entityId).sort()).toEqual([
      "sid_aaaaaaa111",
      "sid_aaaaaaa111",
      "sid_bbbbbbb222",
    ]);
  });

  it("ignores non-yaml files", () => {
    writeFile("notes.md", "hello");
    writeFile(
      "c.yaml",
      `
entityId: sid_ccccccc333
events:
  - { date: "2020", title: C1, eventType: founding }
`,
    );
    const result = loadAllEvents(tmp);
    expect(result.files).toEqual(["c.yaml"]);
    expect(result.events).toHaveLength(1);
  });

  it("throws on duplicate IDs across files", () => {
    writeFile(
      "a.yaml",
      `
entityId: sid_dupdupdup1
events:
  - { date: "2020", title: Same, eventType: founding }
`,
    );
    writeFile(
      "b.yaml",
      `
entityId: sid_dupdupdup1
events:
  - { date: "2020", title: Same, eventType: founding }
`,
    );
    expect(() => loadAllEvents(tmp)).toThrow(/Duplicate event ID/);
  });

  it("propagates per-file validation errors", () => {
    writeFile(
      "bad.yaml",
      `
entityId: sid_eeeeeeee44
events:
  - { date: "no", title: X, eventType: founding }
`,
    );
    expect(() => loadAllEvents(tmp)).toThrow(/bad\.yaml/);
  });

  it("loads .yml as well as .yaml", () => {
    writeFile(
      "x.yml",
      `
entityId: sid_yyyyyyy777
events:
  - { date: "2020", title: Y1, eventType: founding }
`,
    );
    const result = loadAllEvents(tmp);
    expect(result.files).toEqual(["x.yml"]);
    expect(result.events).toHaveLength(1);
  });
});
