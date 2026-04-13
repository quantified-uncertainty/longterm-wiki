/**
 * Schema-level tests for the Linear-ID and slot-number additions to the
 * agent_sessions Zod schemas (QUA-440). Pure Zod — no DB, no HTTP.
 */

import { describe, it, expect } from "vitest";
import {
  CreateAgentSessionSchema,
  UpdateAgentSessionSchema,
  LINEAR_ID_PATTERN,
} from "../api-types.js";

const BASE_CREATE = {
  branch: "claude/qua-440-test",
  task: "test session",
  sessionType: "infrastructure" as const,
  checklistMd: "# checklist",
};

describe("LINEAR_ID_PATTERN", () => {
  it("accepts canonical Linear IDs", () => {
    expect(LINEAR_ID_PATTERN.test("QUA-440")).toBe(true);
    expect(LINEAR_ID_PATTERN.test("ENG-1")).toBe(true);
    expect(LINEAR_ID_PATTERN.test("ABC-123456")).toBe(true);
  });

  it("rejects lowercase, hyphen-less, or malformed IDs", () => {
    expect(LINEAR_ID_PATTERN.test("qua-440")).toBe(false);
    expect(LINEAR_ID_PATTERN.test("QUA440")).toBe(false);
    expect(LINEAR_ID_PATTERN.test("QUA-")).toBe(false);
    expect(LINEAR_ID_PATTERN.test("-440")).toBe(false);
    expect(LINEAR_ID_PATTERN.test("")).toBe(false);
    expect(LINEAR_ID_PATTERN.test("QUA-440 ")).toBe(false);
    expect(LINEAR_ID_PATTERN.test("QUA-440-extra")).toBe(false);
  });
});

describe("CreateAgentSessionSchema (QUA-440)", () => {
  it("accepts a well-formed Linear ID", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      linearId: "QUA-440",
    });
    expect(r.success).toBe(true);
  });

  it("accepts null linearId (existing sessions without a Linear link)", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      linearId: null,
    });
    expect(r.success).toBe(true);
  });

  it("accepts omitted linearId", () => {
    const r = CreateAgentSessionSchema.safeParse(BASE_CREATE);
    expect(r.success).toBe(true);
  });

  it("rejects a malformed Linear ID", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      linearId: "qua-440",
    });
    expect(r.success).toBe(false);
  });

  it("accepts a valid slot number", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      slotNumber: 5,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a negative slot number", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      slotNumber: -1,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a slot number above 99", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      slotNumber: 100,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-integer slot number", () => {
    const r = CreateAgentSessionSchema.safeParse({
      ...BASE_CREATE,
      slotNumber: 5.5,
    });
    expect(r.success).toBe(false);
  });
});

describe("UpdateAgentSessionSchema (QUA-440)", () => {
  it("accepts late-bound linearId on update", () => {
    const r = UpdateAgentSessionSchema.safeParse({ linearId: "QUA-440" });
    expect(r.success).toBe(true);
  });

  it("rejects malformed linearId on update", () => {
    const r = UpdateAgentSessionSchema.safeParse({ linearId: "not a ticket" });
    expect(r.success).toBe(false);
  });
});
