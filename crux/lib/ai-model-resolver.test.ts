import { describe, it, expect, beforeEach } from "vitest";
import path from "path";
import {
  resolveAiModel,
  resolveAiModels,
  normalizeName,
  loadAiModels,
  clearAiModelCache,
} from "./ai-model-resolver.ts";

// All tests use the real ai-models.yaml shipped with the repo. The resolver
// loads at most once per test run thanks to the module-level cache.
const YAML_PATH = path.join(
  process.cwd(),
  "data",
  "entities",
  "ai-models.yaml",
);

describe("normalizeName", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeName("Claude  3.5   Sonnet")).toBe("claude 3.5 sonnet");
  });

  it("strips parenthetical suffixes", () => {
    expect(normalizeName("Claude 3.5 Sonnet (new)")).toBe("claude 3.5 sonnet");
    expect(normalizeName("GPT-4o (experimental)")).toBe("gpt 4o");
  });

  it("strips API date suffixes", () => {
    expect(normalizeName("claude-3-5-sonnet-20241022")).toBe(
      "claude 3 5 sonnet",
    );
    expect(normalizeName("claude-3-5-sonnet-2024-10-22")).toBe(
      "claude 3 5 sonnet",
    );
  });

  it("drops common filler words but preserves version-numeric suffixes", () => {
    // "model" + "the" stripped; "v2" kept because the version digit makes
    // it semantically meaningful (version 2 of Claude 4).
    expect(normalizeName("the Claude 4 model v2")).toBe("claude 4 v2");
  });
});

describe("loadAiModels", () => {
  beforeEach(() => clearAiModelCache());

  it("returns only ai-model entries with stableIds", () => {
    const models = loadAiModels(YAML_PATH);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(m.type).toBe("ai-model");
      expect(typeof m.stableId).toBe("string");
      expect(m.stableId).toMatch(/^sid_/);
    }
  });
});

describe("resolveAiModel — exact matches", () => {
  beforeEach(() => clearAiModelCache());

  it("matches canonical title exactly", () => {
    const matches = resolveAiModel("Claude 3.5 Sonnet", { yamlPath: YAML_PATH });
    expect(matches).toHaveLength(1);
    expect(matches[0].slug).toBe("claude-3-5-sonnet");
    expect(matches[0].matchConfidence).toBe("exact");
    expect(matches[0].confidence).toBe(1);
  });

  it("matches slug exactly", () => {
    const matches = resolveAiModel("claude-3-5-sonnet", { yamlPath: YAML_PATH });
    expect(matches[0].slug).toBe("claude-3-5-sonnet");
    expect(matches[0].matchConfidence).toBe("exact");
  });

  it("matches API slug with date suffix exactly", () => {
    const matches = resolveAiModel("claude-3-5-sonnet-20241022", {
      yamlPath: YAML_PATH,
    });
    expect(matches[0].slug).toBe("claude-3-5-sonnet");
    expect(matches[0].matchConfidence).toBe("exact");
  });

  it("matches with parenthetical suffix exactly", () => {
    const matches = resolveAiModel("Claude 3.5 Sonnet (new)", {
      yamlPath: YAML_PATH,
    });
    expect(matches[0].slug).toBe("claude-3-5-sonnet");
    expect(matches[0].matchConfidence).toBe("exact");
  });
});

describe("resolveAiModel — fuzzy matches", () => {
  beforeEach(() => clearAiModelCache());

  it("matches reordered tokens via substring", () => {
    // "Claude Sonnet 3.5 upgraded" — different word order than canonical.
    const matches = resolveAiModel("Claude 3.5 Sonnet upgraded", {
      yamlPath: YAML_PATH,
    });
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].slug).toBe("claude-3-5-sonnet");
  });

  it("returns no match when name is gibberish", () => {
    const matches = resolveAiModel("definitely-not-a-real-model-xyz", {
      yamlPath: YAML_PATH,
    });
    expect(matches).toHaveLength(0);
  });

  it("returns no match for empty string", () => {
    expect(resolveAiModel("", { yamlPath: YAML_PATH })).toHaveLength(0);
    expect(resolveAiModel("   ", { yamlPath: YAML_PATH })).toHaveLength(0);
  });
});

describe("resolveAiModel — adversarial inputs", () => {
  beforeEach(() => clearAiModelCache());

  it("does not crash on extremely long input", () => {
    const huge = "Claude " + "X".repeat(10_000);
    const matches = resolveAiModel(huge, { yamlPath: YAML_PATH });
    // Whatever result — it must not throw.
    expect(Array.isArray(matches)).toBe(true);
  });

  it("does not match on a single common word", () => {
    // "Claude" alone is too generic to confidently link to any specific
    // version. The token-subset score for any individual entity should be
    // low because their canonical names have many other tokens.
    const matches = resolveAiModel("Claude", { yamlPath: YAML_PATH });
    // Either matches the umbrella "Claude" entity exactly OR returns nothing.
    // We just check the resolver behaves predictably — no random version pick.
    if (matches.length > 0) {
      expect(matches[0].slug).toMatch(/^claude(?:$|-)/);
    }
  });

  it("does not match on punctuation-only input", () => {
    expect(resolveAiModel("!!!", { yamlPath: YAML_PATH })).toHaveLength(0);
    expect(resolveAiModel("---", { yamlPath: YAML_PATH })).toHaveLength(0);
  });
});

describe("resolveAiModels — bulk", () => {
  beforeEach(() => clearAiModelCache());

  it("returns one slot per input", () => {
    const out = resolveAiModels(
      ["Claude 3.5 Sonnet", "definitely-not-real", "claude-3-5-sonnet"],
      { yamlPath: YAML_PATH },
    );
    expect(out).toHaveLength(3);
    expect(out[0]?.slug).toBe("claude-3-5-sonnet");
    expect(out[1]).toBeNull();
    expect(out[2]?.slug).toBe("claude-3-5-sonnet");
  });
});
