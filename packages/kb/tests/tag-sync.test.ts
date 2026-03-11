/**
 * Tests that CUSTOM_TAGS exported by the KB loader stay synchronized with
 * the KB writer's usage. Catches regressions like changing tag behavior
 * or adding a new tag without updating round-trip serialization.
 */

import { describe, it, expect } from "vitest";
import {
  parse as parseYaml,
  parseDocument,
  stringify as stringifyYaml,
} from "yaml";
import { CUSTOM_TAGS, RefMarker, DateMarker, SrcMarker } from "../src/loader";

describe("CUSTOM_TAGS synchronization", () => {
  it("exports exactly the three core tags (!ref, !date, !src)", () => {
    // Exact match — forces test update when tags are added/removed
    expect(CUSTOM_TAGS.length).toBe(3);
    const tagNames = CUSTOM_TAGS.map((t) => t.tag);
    expect(tagNames).toContain("!ref");
    expect(tagNames).toContain("!date");
    expect(tagNames).toContain("!src");
  });

  it("every tag has required ScalarTag properties", () => {
    for (const tag of CUSTOM_TAGS) {
      expect(typeof tag.tag).toBe("string");
      expect(typeof tag.resolve).toBe("function");
      expect(typeof tag.identify).toBe("function");
      expect(typeof tag.stringify).toBe("function");
    }
  });

  it("!ref survives stringify → parse round-trip with correct value", () => {
    const original = { ref: new RefMarker("abc1234567", "some-slug") };
    const yaml = stringifyYaml(original, { customTags: CUSTOM_TAGS });

    // Tag and value appear together
    expect(yaml).toContain("!ref abc1234567:some-slug");

    const parsed = parseYaml(yaml, { customTags: CUSTOM_TAGS }) as Record<
      string,
      unknown
    >;
    expect(parsed.ref).toBeInstanceOf(RefMarker);
    const ref = parsed.ref as RefMarker;
    expect(ref.stableId).toBe("abc1234567");
    expect(ref.expectedSlug).toBe("some-slug");
  });

  it("!date survives stringify → parse round-trip with correct value", () => {
    const original = { date: new DateMarker("2024-06") };
    const yaml = stringifyYaml(original, { customTags: CUSTOM_TAGS });

    expect(yaml).toContain("!date 2024-06");

    const parsed = parseYaml(yaml, { customTags: CUSTOM_TAGS }) as Record<
      string,
      unknown
    >;
    expect(parsed.date).toBeInstanceOf(DateMarker);
    expect((parsed.date as DateMarker).value).toBe("2024-06");
  });

  it("!src survives stringify → parse round-trip with correct value", () => {
    const original = { src: new SrcMarker("my-alias") };
    const yaml = stringifyYaml(original, { customTags: CUSTOM_TAGS });

    expect(yaml).toContain("!src my-alias");

    const parsed = parseYaml(yaml, { customTags: CUSTOM_TAGS }) as Record<
      string,
      unknown
    >;
    expect(parsed.src).toBeInstanceOf(SrcMarker);
    expect((parsed.src as SrcMarker).alias).toBe("my-alias");
  });

  it("parseDocument (used by kb-writer) preserves all tags through toString()", () => {
    const yaml = [
      "ref_field: !ref abc1234567:some-slug",
      "date_field: !date 2025-01",
      "src_field: !src my-source",
    ].join("\n");

    const doc = parseDocument(yaml, { customTags: CUSTOM_TAGS });
    const output = doc.toString();

    // Check tag + value appear together on the correct field
    expect(output).toContain("!ref abc1234567:some-slug");
    expect(output).toContain("!date 2025-01");
    expect(output).toContain("!src my-source");
  });

  it("parseDocument does NOT add tags to new plain values", () => {
    // Simulates what kb-writer does: parse a doc, add new nodes, serialize
    const yaml = "existing: !date 2024-06\n";
    const doc = parseDocument(yaml, { customTags: CUSTOM_TAGS });

    // Add a new plain string value that looks like a date
    const contents = doc.contents as import("yaml").YAMLMap;
    const newNode = doc.createNode("2025-01");
    contents.set("new_field", newNode);

    const output = doc.toString();

    // Existing tagged value should keep its tag
    expect(output).toContain("!date 2024-06");
    // New plain string should NOT get a tag
    expect(output).toMatch(/new_field: ['"]?2025-01/);
    expect(output).not.toMatch(/new_field: !date/);
  });
});
