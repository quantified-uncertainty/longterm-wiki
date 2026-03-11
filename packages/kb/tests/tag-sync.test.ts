/**
 * Tests that CUSTOM_TAGS exported by the KB loader stay synchronized with
 * the KB writer's usage. Catches regressions like adding a new tag to the
 * loader that the writer doesn't handle, or changing tag behavior.
 */

import { describe, it, expect } from "vitest";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { CUSTOM_TAGS } from "../src/loader";

describe("CUSTOM_TAGS synchronization", () => {
  it("exports at least the three core tags (!ref, !date, !src)", () => {
    expect(CUSTOM_TAGS.length).toBeGreaterThanOrEqual(3);
    const tagNames = CUSTOM_TAGS.map((t) => t.tag);
    expect(tagNames).toContain("!ref");
    expect(tagNames).toContain("!date");
    expect(tagNames).toContain("!src");
  });

  it("every tag has tag, resolve, identify, and stringify properties", () => {
    for (const tag of CUSTOM_TAGS) {
      expect(tag).toHaveProperty("tag");
      expect(tag).toHaveProperty("resolve");
      expect(tag).toHaveProperty("identify");
      expect(tag).toHaveProperty("stringify");
      expect(typeof tag.tag).toBe("string");
      expect(typeof tag.resolve).toBe("function");
      expect(typeof tag.identify).toBe("function");
      expect(typeof tag.stringify).toBe("function");
    }
  });

  it("each tag survives a YAML stringify -> parse round-trip", () => {
    const samples: Record<string, string> = {
      "!ref": "abc1234567:some-slug",
      "!date": "2024-06",
      "!src": "my-alias",
    };

    for (const tag of CUSTOM_TAGS) {
      const yamlInput = `value: ${tag.tag} ${samples[tag.tag]}`;
      const parsed = parseYaml(yamlInput, { customTags: CUSTOM_TAGS });
      const serialized = stringifyYaml(parsed, { customTags: CUSTOM_TAGS });
      expect(serialized).toContain(tag.tag);

      const reparsed = parseYaml(serialized, { customTags: CUSTOM_TAGS });
      const reserializedAgain = stringifyYaml(reparsed, {
        customTags: CUSTOM_TAGS,
      });
      expect(reserializedAgain).toContain(tag.tag);
    }
  });

  it("parseDocument (used by kb-writer) preserves all tags via toString()", () => {
    const yaml = [
      "ref_field: !ref abc1234567:some-slug",
      "date_field: !date 2025-01",
      "src_field: !src my-source",
    ].join("\n");

    const doc = parseDocument(yaml, { customTags: CUSTOM_TAGS });
    const output = doc.toString();

    expect(output).toContain("!ref");
    expect(output).toContain("abc1234567:some-slug");
    expect(output).toContain("!date");
    expect(output).toContain("2025-01");
    expect(output).toContain("!src");
    expect(output).toContain("my-source");
  });
});
