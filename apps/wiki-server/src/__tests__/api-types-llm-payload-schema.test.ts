/**
 * Schema validation for RecordLlmPayloadSchema (model-swap eval, step 1b).
 *
 * The POST /api/llm-payloads endpoint persists captured LLM request/response
 * bodies. Validate at the boundary: model is required, oversize request/response
 * are rejected (server-side backstop to the logger's own truncation).
 */
import { describe, it, expect } from "vitest";
import {
  RecordLlmPayloadSchema,
  MAX_LLM_PAYLOAD_REQUEST_BYTES,
  MAX_LLM_PAYLOAD_RESPONSE_CHARS,
} from "../api-types.js";

describe("RecordLlmPayloadSchema", () => {
  const baseValid = {
    model: "claude-haiku-4-5-20251001",
    request: { system: "sys", messages: [{ role: "user", content: "hi" }] },
    response: "hello",
  };

  it("accepts a minimal valid payload", () => {
    expect(RecordLlmPayloadSchema.safeParse(baseValid).success).toBe(true);
  });

  it("accepts optional flow/runId/label/tokens", () => {
    const r = RecordLlmPayloadSchema.safeParse({
      ...baseValid,
      runId: "11111111-1111-4111-8111-111111111111",
      flow: "research-agent",
      label: "verify",
      viaOpenrouter: true,
      tokensInput: 10,
      tokensOutput: 5,
      truncated: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a missing model", () => {
    const { model: _omit, ...noModel } = baseValid;
    expect(RecordLlmPayloadSchema.safeParse(noModel).success).toBe(false);
  });

  it("rejects a request that serializes over the byte cap", () => {
    const big = { blob: "x".repeat(MAX_LLM_PAYLOAD_REQUEST_BYTES + 100) };
    const r = RecordLlmPayloadSchema.safeParse({ ...baseValid, request: big });
    expect(r.success).toBe(false);
  });

  it("rejects a response over the char cap", () => {
    const r = RecordLlmPayloadSchema.safeParse({
      ...baseValid,
      response: "x".repeat(MAX_LLM_PAYLOAD_RESPONSE_CHARS + 1),
    });
    expect(r.success).toBe(false);
  });

  it("rejects a malformed runId", () => {
    const r = RecordLlmPayloadSchema.safeParse({ ...baseValid, runId: "not a uuid!" });
    expect(r.success).toBe(false);
  });
});
