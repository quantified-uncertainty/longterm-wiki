import { describe, it, expect } from "vitest";
import { z } from "zod";
import { qBool } from "../routes/shared/utils.js";

// QUA-651: `z.coerce.boolean()` silently coerces every non-empty string
// (including `"false"`) to `true`. `qBool` is the safe replacement — these
// tests lock in the adversarial cases that `z.coerce.boolean()` would get
// wrong, and confirm the strict rejection behaviour for anything else.

describe("qBool", () => {
  it('parses "true" → true', () => {
    expect(qBool.parse("true")).toBe(true);
  });

  it('parses "false" → false (the z.coerce.boolean() footgun)', () => {
    // z.coerce.boolean().parse("false") would incorrectly return true here.
    expect(qBool.parse("false")).toBe(false);
  });

  it.each([
    "True",
    "FALSE",
    "1",
    "0",
    "yes",
    "no",
    "",
    " true",
    "true ",
    "TRUE",
  ])('rejects ambiguous input %j with a validation error', (input) => {
    expect(() => qBool.parse(input)).toThrow(z.ZodError);
  });

  it.each([undefined, null, 0, 1, true, false, {}, []])(
    'rejects non-string input %j',
    (input) => {
      expect(() => qBool.parse(input)).toThrow(z.ZodError);
    },
  );

  it("is optional-composable — omitted query param yields undefined", () => {
    const Schema = z.object({ flag: qBool.optional() });
    expect(Schema.parse({})).toEqual({ flag: undefined });
    expect(Schema.parse({ flag: "true" })).toEqual({ flag: true });
    expect(Schema.parse({ flag: "false" })).toEqual({ flag: false });
  });

  it("rejects invalid values even when wrapped with .optional()", () => {
    const Schema = z.object({ flag: qBool.optional() });
    expect(() => Schema.parse({ flag: "FALSE" })).toThrow(z.ZodError);
    expect(() => Schema.parse({ flag: "1" })).toThrow(z.ZodError);
  });

  it("composes with .default('true') and .default('false')", () => {
    // .default applies the default to the Zod *input* (pre-transform), so
    // .default("true") → transform sees "true" → returns true. Pin this
    // subtlety since a caller might plausibly write qBool.default("false").
    const A = z.object({ flag: qBool.default("true") });
    const B = z.object({ flag: qBool.default("false") });
    expect(A.parse({})).toEqual({ flag: true });
    expect(B.parse({})).toEqual({ flag: false });
    expect(A.parse({ flag: "false" })).toEqual({ flag: false });
  });
});
