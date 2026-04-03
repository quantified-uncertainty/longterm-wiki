import { describe, it, expect } from "vitest";
import { buildModelMatcher, pickBestScore } from "../model-matcher.ts";

const MODELS = [
  { id: "claude-sonnet-4-6", stableId: "sid_Au1yMEZYWQ", title: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-6", stableId: "sid_Ac7c55KtVw", title: "Claude Opus 4.6" },
  { id: "claude-opus-4-5", stableId: "sid_tppPAkJqjQ", title: "Claude Opus 4.5" },
  { id: "gpt-4o", stableId: "sid_ziNB5viRfw", title: "GPT-4o" },
  { id: "gpt-4o-mini", stableId: "sid_6zbeHdP49g", title: "GPT-4o mini" },
  { id: "gpt-4-1", stableId: "sid_EvEua2w8IA", title: "GPT-4.1" },
  { id: "o3", stableId: "sid_x0Qhowq8zA", title: "o3" },
  { id: "o3-mini", stableId: "sid_nTRFbfAcAw", title: "o3-mini" },
  { id: "gemini-2-5-pro", stableId: "sid_FmNMFeajhg", title: "Gemini 2.5 Pro" },
  { id: "gemini-2-5-flash", stableId: "sid_a5llQhfVkw", title: "Gemini 2.5 Flash" },
  { id: "deepseek-r1", stableId: "sid_jhJqRVFXcg", title: "DeepSeek R1" },
  { id: "deepseek-v3", stableId: "sid_DysvXRWdOQ", title: "DeepSeek V3" },
  { id: "llama-3-1", stableId: "sid_kNi5nDKetA", title: "Llama 3.1" },
  { id: "llama-4-maverick", stableId: "sid_T3ipFW0POA", title: "Llama 4 Maverick" },
  { id: "grok-3", stableId: "sid_ELbPFPb5vA", title: "Grok-3" },
];

describe("buildModelMatcher", () => {
  const match = buildModelMatcher(MODELS);

  // Anthropic models
  it("matches Claude Sonnet 4.6 with config suffix", () => {
    const result = match("claude-sonnet-4-6_32K");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("claude-sonnet-4-6");
    expect(result!.stableId).toBe("sid_Au1yMEZYWQ");
  });

  it("matches Claude Opus 4.6 with date suffix", () => {
    const result = match("claude-opus-4-6_64K");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("claude-opus-4-6");
  });

  it("matches Claude Opus 4.5 with date suffix", () => {
    const result = match("claude-opus-4-5-20251101_32K");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("claude-opus-4-5");
  });

  // OpenAI models
  it("matches GPT-4o with date suffix", () => {
    const result = match("gpt-4o-2024-11-20");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("gpt-4o");
  });

  it("matches GPT-4o mini", () => {
    const result = match("gpt-4o-mini-2024-07-18");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("gpt-4o-mini");
  });

  it("matches GPT-4.1 with dot notation", () => {
    const result = match("gpt-4.1-2025-04-14");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("gpt-4-1");
  });

  it("matches o3 with date suffix", () => {
    const result = match("o3-2025-04-16_medium");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("o3");
  });

  it("matches o3-mini", () => {
    const result = match("o3-mini-2025-01-31_medium");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("o3-mini");
  });

  it("matches o3-pro to o3 family", () => {
    const result = match("o3-pro-2025-06-10_high");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("o3");
  });

  // Google models
  it("matches Gemini 2.5 Pro with dots and preview suffix", () => {
    const result = match("gemini-2.5-pro-preview-06-05_32K");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("gemini-2-5-pro");
  });

  it("matches Gemini 2.5 Flash", () => {
    const result = match("gemini-2.5-flash-preview-05-20_23K");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("gemini-2-5-flash");
  });

  // DeepSeek
  it("matches deepseek-reasoner to DeepSeek R1", () => {
    const result = match("deepseek-reasoner");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("deepseek-r1");
  });

  it("matches DeepSeek V3 variants", () => {
    const result = match("DeepSeek-V3.2-Exp_thinking");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("deepseek-v3");
  });

  // Meta models
  it("matches Llama 4 Maverick with size suffix", () => {
    const result = match("Llama-4-Maverick-17B-128E-Instruct");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("llama-4-maverick");
  });

  it("matches Meta-Llama-3.1 variant", () => {
    const result = match("Meta-Llama-3.1-405B-Instruct");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("llama-3-1");
  });

  // xAI
  it("matches Grok 3 variants", () => {
    const result = match("grok-3-beta");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("grok-3");
  });

  it("matches Grok 4 to Grok 3 family", () => {
    const result = match("grok-4-0709");
    expect(result).not.toBeNull();
    expect(result!.entitySlug).toBe("grok-3");
  });

  // Provider prefix stripping
  it("strips provider prefix (fireworks/)", () => {
    const result = match("fireworks/kimi-k2p5");
    // kimi-k2 doesn't exist in our test models, so null
    expect(result).toBeNull();
  });

  // Unmatched models
  it("returns null for unknown models", () => {
    expect(match("Baichuan-13B-Base")).toBeNull();
    expect(match("phi-4")).toBeNull();
    expect(match("totally-unknown-model")).toBeNull();
  });
});

describe("pickBestScore", () => {
  it("picks highest score when higherIsBetter is true", () => {
    const scores = [
      { score: 0.7, epochModelVersion: "model_low" },
      { score: 0.9, epochModelVersion: "model_high" },
      { score: 0.8, epochModelVersion: "model_medium" },
    ];
    const best = pickBestScore(scores, true);
    expect(best.score).toBe(0.9);
    expect(best.epochModelVersion).toBe("model_high");
  });

  it("picks lowest score when higherIsBetter is false", () => {
    const scores = [
      { score: 0.7, epochModelVersion: "model_low" },
      { score: 0.9, epochModelVersion: "model_high" },
      { score: 0.5, epochModelVersion: "model_best" },
    ];
    const best = pickBestScore(scores, false);
    expect(best.score).toBe(0.5);
    expect(best.epochModelVersion).toBe("model_best");
  });

  it("works with single entry", () => {
    const scores = [{ score: 0.85, epochModelVersion: "only-model" }];
    const best = pickBestScore(scores);
    expect(best.score).toBe(0.85);
  });
});
